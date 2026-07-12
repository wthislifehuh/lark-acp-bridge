#!/usr/bin/env node
/**
 * `lark-acp-q` — an ACP agent adapter for the **Amazon Q Developer CLI** (`q`).
 *
 * Amazon Q does not speak ACP natively (see
 * https://github.com/aws/amazon-q-developer-cli/issues/2703 — AWS moved that
 * investment to Kiro CLI, "the closed-source successor to Amazon Q", which
 * *does* ship native ACP via `kiro-cli acp`). This adapter lets the classic
 * `q` CLI plug into the Lark bridge anyway by translating between ACP
 * (JSON-RPC over stdio, spoken to the bridge) and one-shot `q chat`
 * invocations (spoken to Amazon Q).
 *
 * Design (see README "接入 Amazon Q" for the rationale):
 *
 * - Each ACP session owns an in-memory transcript. On every prompt we replay
 *   that transcript as context into a fresh `q chat --no-interactive` process,
 *   stream its stdout back as `agent_message_chunk`s, then append the turn to
 *   the transcript. This keeps concurrent Lark chats isolated even when they
 *   share one working directory — `q`'s own `--resume` is keyed by directory
 *   and would cross-contaminate them.
 * - The transcript is persisted per session id so `session/load` (used by the
 *   bridge to resume after a restart) can restore it.
 *
 * Inherent limitations of driving `q` (documented, not bugs):
 *
 * 1. Non-interactive `q` must trust tools up front (otherwise it blocks
 *    waiting for a TTY), so per-tool Lark permission cards are not possible.
 * 2. `q chat` emits unstructured text (no JSON event stream), so thoughts and
 *    tool calls are not split out — the answer streams as one message.
 *
 * Pure helpers (config, transcript shaping, argv construction) live in
 * `./q-acp-core.ts`; this file owns the process and stream lifecycle.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  buildQArgs,
  buildQInput,
  capHistory,
  flattenPrompt,
  isQAuthFailure,
  loadConfig,
  parseTranscriptFile,
  sessionFilePath,
  stripAnsi,
  QChatError,
  SESSION_FILE_VERSION,
  type QAdapterConfig,
  type TranscriptMessage,
} from "./q-acp-core.js";

const PROTOCOL_LOG_PREFIX = "[q-acp]";
const AGENT_NAME = "lark-acp-q";
const AGENT_VERSION = "0.1.0";

const WIN32_PLATFORM = "win32";
const STDERR_TAIL_LINES = 20;

const EMPTY_OUTPUT_NOTE = "_(Amazon Q 未返回任何内容)_";
const EMPTY_PROMPT_NOTE = "_(空消息，未调用 Amazon Q)_";

/** Windows cannot spawn `.cmd`/`.bat` without a shell (Node ≥18.17 EINVAL). */
const WINDOWS_SCRIPT_BIN_PATTERN = /\.(cmd|bat)$/i;

const LAUNCH_HINT =
  "is the Amazon Q CLI installed and on PATH? " +
  "(注意：Amazon Q CLI 不支持原生 Windows，需在 WSL / Linux / macOS 内运行)";

interface SessionState {
  cwd: string;
  transcript: TranscriptMessage[];
  child: ChildProcess | null;
  cancelled: boolean;
}

type TurnOutcome = "done" | "cancelled";

class QAgent implements acp.Agent {
  private readonly connection: acp.AgentSideConnection;
  private readonly config: QAdapterConfig;
  private readonly sessions = new Map<string, SessionState>();
  /** Serialises outgoing session updates so streamed chunks stay ordered. */
  private emitChain: Promise<void> = Promise.resolve();

  constructor(connection: acp.AgentSideConnection, config: QAdapterConfig) {
    this.connection = connection;
    this.config = config;
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
    };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      cwd: params.cwd,
      transcript: [],
      child: null,
      cancelled: false,
    });
    return { sessionId };
  }

  /**
   * Restore a session persisted by a previous run.
   *
   * @throws when no valid transcript exists for `sessionId`; the bridge then
   *         falls back to {@link newSession}.
   */
  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const file = sessionFilePath(this.config.dataDir, params.sessionId);
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, "utf8");
    } catch (err) {
      throw new Error(`No stored transcript for session ${params.sessionId}`, { cause: err });
    }
    const transcript = parseTranscriptFile(raw);
    this.sessions.set(params.sessionId, {
      cwd: params.cwd,
      transcript,
      child: null,
      cancelled: false,
    });
    return {};
  }

  async setSessionMode(
    _params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse | void> {
    return {};
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session?.child) return;
    session.cancelled = true;
    killChild(session.child);
  }

  /**
   * Run one turn: replay context into a fresh `q chat`, stream its output,
   * and record the exchange.
   *
   * @throws {QChatError} when `q` cannot be spawned or exits non-zero.
   */
  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    // The bridge serialises prompts per chat, but guard anyway.
    if (session.child) killChild(session.child);
    session.cancelled = false;

    const userText = flattenPrompt(params.prompt);
    if (!userText) {
      this.emit(params.sessionId, EMPTY_PROMPT_NOTE);
      await this.emitChain;
      return { stopReason: "end_turn" };
    }

    const qInput = buildQInput(session.transcript, userText);
    const args = buildQArgs(this.config, qInput);

    const { assistantText, outcome } = await this.runQ(params.sessionId, session, args);

    // Flush any in-flight streamed chunks before the turn is reported done, so
    // the bridge renders the full answer before it finalises the card.
    await this.emitChain;

    if (outcome === "cancelled") return { stopReason: "cancelled" };

    session.transcript.push({ role: "user", text: userText });
    session.transcript.push({ role: "assistant", text: assistantText });
    session.transcript = capHistory(
      session.transcript,
      this.config.maxHistoryMessages,
      this.config.maxHistoryChars,
    );
    await this.persist(params.sessionId, session);

    return { stopReason: "end_turn" };
  }

  private runQ(
    sessionId: string,
    session: SessionState,
    args: readonly string[],
  ): Promise<{ assistantText: string; outcome: TurnOutcome }> {
    return new Promise((resolve, reject) => {
      if (process.platform === WIN32_PLATFORM && WINDOWS_SCRIPT_BIN_PATTERN.test(this.config.bin)) {
        reject(
          new QChatError(
            `Q_ACP_BIN 指向了 \`${this.config.bin}\`：Windows 上无法直接派生 .cmd/.bat（且 Amazon Q CLI 需在 WSL 内运行）。请改指可执行文件本体。`,
            null,
            [],
          ),
        );
        return;
      }

      const child = spawn(this.config.bin, [...args], {
        cwd: session.cwd,
        // `NO_COLOR`/`TERM=dumb` reduce decorative output; stripAnsi cleans the rest.
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
        stdio: ["ignore", "pipe", "pipe"],
        // No shell: pass the (multi-line) prompt as a single argv element safely.
        shell: false,
        windowsHide: true,
      });
      session.child = child;

      let assistant = "";
      let stdoutCarry = "";
      const stderrTail: string[] = [];

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutCarry += chunk.toString("utf8");
        const parts = stdoutCarry.split(/\r?\n/);
        stdoutCarry = parts.pop() ?? "";
        if (parts.length === 0) return;
        // Batch all completed lines from this chunk into one session update.
        const text = parts.map((line) => `${stripAnsi(line)}\n`).join("");
        assistant += text;
        this.emit(sessionId, text);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        for (const part of chunk.toString("utf8").split(/\r?\n/)) {
          const line = stripAnsi(part).trim();
          if (!line) continue;
          stderrTail.push(line);
          if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
        }
      });

      child.on("error", (err) => {
        session.child = null;
        reject(
          new QChatError(
            `Failed to launch \`${this.config.bin}\` — ${LAUNCH_HINT}`,
            null,
            stderrTail,
            { cause: err },
          ),
        );
      });

      child.on("close", (code, signal) => {
        session.child = null;
        if (stdoutCarry.length > 0) {
          const text = stripAnsi(stdoutCarry.replace(/\r$/, ""));
          assistant += text;
          this.emit(sessionId, text);
        }

        if (session.cancelled) {
          resolve({ assistantText: assistant, outcome: "cancelled" });
          return;
        }
        if (code === 0 || code === null) {
          if (assistant.trim().length === 0) {
            assistant = EMPTY_OUTPUT_NOTE;
            this.emit(sessionId, EMPTY_OUTPUT_NOTE);
          }
          resolve({ assistantText: assistant, outcome: "done" });
          return;
        }

        const exitDetail = `exited with code ${code}${signal ? ` (signal ${signal})` : ""}`;
        // "Authentication required" is deliberate: the bridge pattern-matches
        // it (isAuthenticationError) and tears the runtime down instead of
        // retrying — a `q login` is needed either way.
        const message = isQAuthFailure(stderrTail)
          ? `Authentication required: \`${this.config.bin} login\` 后重试 (${exitDetail})`
          : `\`${this.config.bin} chat\` ${exitDetail}`;
        reject(new QChatError(message, code, stderrTail));
      });
    });
  }

  /** Queue a text chunk as an `agent_message_chunk`, preserving order. */
  private emit(sessionId: string, text: string): void {
    this.emitChain = this.emitChain
      .then(() =>
        this.connection.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        }),
      )
      .catch((err: unknown) => {
        process.stderr.write(`${PROTOCOL_LOG_PREFIX} sessionUpdate failed: ${String(err)}\n`);
      });
  }

  private async persist(sessionId: string, session: SessionState): Promise<void> {
    const file = sessionFilePath(this.config.dataDir, sessionId);
    const payload = {
      version: SESSION_FILE_VERSION,
      sessionId,
      cwd: session.cwd,
      transcript: session.transcript,
      updatedAt: Date.now(),
    };
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fs.promises.rename(tmp, file);
    } catch (err) {
      // Persistence is a best-effort convenience (enables resume-after-restart);
      // never fail a turn over it.
      process.stderr.write(`${PROTOCOL_LOG_PREFIX} session persist failed: ${String(err)}\n`);
    }
  }
}

function killChild(child: ChildProcess): void {
  try {
    if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
  } catch {
    // already dead
  }
}

function main(): void {
  const config = loadConfig(process.env);
  // ACP over stdio: the bridge writes to our stdin, we answer on stdout.
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);
  new acp.AgentSideConnection((conn) => new QAgent(conn, config), stream);
  process.stderr.write(`${PROTOCOL_LOG_PREFIX} ready (bin=${config.bin})\n`);
}

main();
