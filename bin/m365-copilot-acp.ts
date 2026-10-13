#!/usr/bin/env node
/**
 * `lark-acp-m365` — an ACP agent adapter for **Microsoft 365 Copilot**
 * (the work chat at https://m365.cloud.microsoft/chat, a.k.a. BizChat).
 *
 * M365 Copilot has no ACP-speaking CLI (verified 2026-07 — see
 * docs/microsoft-copilot-plan.md). This adapter translates between ACP
 * (JSON-RPC over stdio, spoken to the bridge) and the **Microsoft 365
 * Copilot Chat API** (Microsoft Graph, `/beta/copilot/conversations`) —
 * Microsoft's official programmatic surface for BizChat.
 *
 * ⚠ The Chat API is public preview (`/beta`): delegated auth only (a real
 * signed-in user), every calling user needs an M365 Copilot license, not
 * available in the 21Vianet (China) cloud, and Microsoft may change it.
 *
 * Design:
 *
 * - Auth: one-time `lark-acp-m365 login` (MSAL device-code flow, cache on
 *   disk), silent refresh at runtime. App-only identity is not supported by
 *   the API itself.
 * - An ACP session maps to a Graph Copilot conversation id (created lazily,
 *   persisted for `session/load`); multi-turn context lives server-side.
 * - Streaming: `chatOverStream` emits SSE events whose `data:` payloads are
 *   *cumulative* conversation snapshots. The delta tracker emits only unseen
 *   suffixes, holding back incomplete `<Tag>` / `[^n^]` tokens so cleanup
 *   never sees a torn marker. Set `M365_COPILOT_STREAMING=false` to use the
 *   synchronous `chat` endpoint instead.
 *
 * Pure helpers live in `./m365-copilot-acp-core.ts`; this file owns the ACP
 * connection, auth, and HTTP.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  SnapshotDeltaTracker,
  SseParser,
  buildChatRequestBody,
  cleanResponseText,
  describeGraphFailure,
  extractResponseMessage,
  loadConfig,
  parseConversationSnapshot,
  renderAttributions,
  validateConfig,
  type ConversationMessage,
  type M365CopilotAdapterConfig,
} from "./m365-copilot-acp-core.js";
import {
  CONVERSATION_SESSION_FILE_VERSION,
  parseConversationSessionFile,
  sessionFilePath,
} from "./session-file.js";
import { acquireTokenSilently, loginWithDeviceCode, type MsalAuthOptions } from "./msal-auth.js";
import { flattenPrompt } from "./prompt-text.js";

const PROTOCOL_LOG_PREFIX = "[m365-copilot-acp]";
const AGENT_NAME = "lark-acp-m365";
const AGENT_VERSION = "0.1.0";
const LOGIN_COMMAND = "lark-acp-m365 login";
const MSAL_CACHE_FILE = "msal-cache.json";

const EMPTY_OUTPUT_NOTE = "_(Microsoft 365 Copilot returned no content)_";
const EMPTY_PROMPT_NOTE = "_(empty message — Microsoft 365 Copilot was not called)_";

/** How much of an upstream error body to keep for the failure card. */
const FAILURE_BODY_TAIL_CHARS = 400;

/**
 * Abort reason used for the turn deadline, so a timeout can be told apart
 * from a user cancel (which aborts with the default `AbortError`) by
 * inspecting `signal.reason` in the catch block.
 */
const TURN_TIMEOUT_REASON = Symbol("m365-turn-timeout");

interface SessionState {
  conversationId: string | null;
  cancelled: boolean;
  abortController: AbortController | null;
}

/** The turn exceeded `M365_COPILOT_TURN_TIMEOUT_MS`. */
class TurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Microsoft 365 Copilot response timed out (${String(timeoutMs)} ms)`);
    this.name = "TurnTimeoutError";
  }
}

/** A non-2xx response from Graph, already turned into a user-facing message. */
class GraphRequestError extends Error {
  readonly status: number;

  constructor(status: number, bodyTail: string, loginCommand: string) {
    super(describeGraphFailure(status, bodyTail, loginCommand));
    this.name = "GraphRequestError";
    this.status = status;
  }
}

function buildMsalOptions(config: M365CopilotAdapterConfig): MsalAuthOptions {
  if (config.tenantId === null || config.appClientId === null) {
    throw new Error("missing M365_COPILOT_TENANT_ID / M365_COPILOT_APP_CLIENT_ID");
  }
  return {
    clientId: config.appClientId,
    tenantId: config.tenantId,
    scopes: config.scopes,
    cacheFilePath: path.join(config.dataDir, MSAL_CACHE_FILE),
    ...(config.authorityBase !== null ? { authorityBase: config.authorityBase } : {}),
  };
}

function createTokenSource(config: M365CopilotAdapterConfig): () => Promise<string> {
  const token = config.staticToken;
  if (token !== null) return () => Promise.resolve(token);
  const options = buildMsalOptions(config);
  return () => acquireTokenSilently(options, LOGIN_COMMAND);
}

class M365CopilotAgent implements acp.Agent {
  private readonly connection: acp.AgentSideConnection;
  private readonly config: M365CopilotAdapterConfig;
  private readonly getToken: () => Promise<string>;
  private readonly sessions = new Map<string, SessionState>();
  /** Serialises outgoing session updates so streamed chunks stay ordered. */
  private emitChain: Promise<void> = Promise.resolve();

  constructor(connection: acp.AgentSideConnection, config: M365CopilotAdapterConfig) {
    this.connection = connection;
    this.config = config;
    this.getToken = createTokenSource(config);
  }

  initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return Promise.resolve({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
    });
  }

  authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return Promise.resolve({});
  }

  newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { conversationId: null, cancelled: false, abortController: null });
    return Promise.resolve({ sessionId });
  }

  /**
   * Restore a session persisted by a previous run (conversation context
   * itself lives on Microsoft's side).
   *
   * @throws when no valid session file exists for `sessionId`; the bridge
   *         then falls back to {@link newSession}.
   */
  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const file = sessionFilePath(this.config.dataDir, params.sessionId);
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, "utf8");
    } catch (err) {
      throw new Error(`No stored conversation for session ${params.sessionId}`, { cause: err });
    }
    const stored = parseConversationSessionFile(raw);
    this.sessions.set(params.sessionId, {
      conversationId: stored.conversationId,
      cancelled: false,
      abortController: null,
    });
    return {};
  }

  setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    return Promise.resolve({});
  }

  cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return Promise.resolve();
    session.cancelled = true;
    session.abortController?.abort();
    return Promise.resolve();
  }

  /**
   * Run one turn: lazily create the Graph conversation, post the prompt, and
   * stream the answer back as message chunks.
   *
   * @throws {GraphRequestError} when Graph rejects a request (401/403/...).
   * @throws {TurnTimeoutError} when the turn exceeds the configured timeout.
   * @throws when silent token acquisition fails (message starts with
   *         "Authentication required").
   */
  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    session.cancelled = false;

    const userText = flattenPrompt(params.prompt);
    if (!userText) {
      this.emit(params.sessionId, EMPTY_PROMPT_NOTE);
      await this.emitChain;
      return { stopReason: "end_turn" };
    }

    // Create the abort controller BEFORE any awaits (token acquisition, lazy
    // conversation creation) so a cancel delivered during that window is
    // honored — otherwise cancel() would abort a still-null controller and the
    // cancelled turn would go on to stream its full answer.
    const deadline = Date.now() + this.config.turnTimeoutMs;
    const controller = new AbortController();
    session.abortController = controller;
    const timer = setTimeout(
      () => {
        controller.abort(TURN_TIMEOUT_REASON);
      },
      Math.max(0, deadline - Date.now()),
    );

    try {
      const token = await this.getToken();
      session.conversationId ??= await this.createConversation(token, controller.signal);
      if (this.config.streaming) {
        await this.runStreamingTurn(
          params.sessionId,
          session.conversationId,
          token,
          userText,
          controller.signal,
        );
      } else {
        await this.runSyncTurn(
          params.sessionId,
          session.conversationId,
          token,
          userText,
          controller.signal,
        );
      }
      await this.emitChain;
      await this.persist(params.sessionId, session);
      return { stopReason: "end_turn" };
    } catch (err: unknown) {
      // A cancel/timeout aborts the in-flight fetch (or a signal aborted during
      // getToken makes the next fetch reject at once). classifyTurnError returns
      // for a user cancel and rethrows a timeout / real error.
      this.classifyTurnError(session, controller, err);
      await this.emitChain;
      return { stopReason: "cancelled" };
    } finally {
      clearTimeout(timer);
      session.abortController = null;
    }
  }

  /**
   * @throws {GraphRequestError} on a non-2xx response.
   */
  private async createConversation(token: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/copilot/conversations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal,
    });
    if (!response.ok) {
      throw new GraphRequestError(response.status, await readBodyTail(response), LOGIN_COMMAND);
    }
    const snapshot = parseConversationSnapshot(await response.text());
    if (!snapshot.id) {
      throw new Error("Microsoft Graph create-conversation response is missing the id field");
    }
    return snapshot.id;
  }

  /**
   * Stream a turn over `chatOverStream`. Abort/timeout surface as a thrown
   * error that {@link prompt} classifies (the controller/timer lifecycle is
   * owned by `prompt`).
   *
   * @throws {GraphRequestError} on a non-2xx response.
   * @throws an `AbortError` when the shared signal is aborted (cancel/timeout).
   */
  private async runStreamingTurn(
    sessionId: string,
    conversationId: string,
    token: string,
    userText: string,
    signal: AbortSignal,
  ): Promise<void> {
    const tracker = new SnapshotDeltaTracker();
    let lastMessage: ConversationMessage | null = null;

    const response = await fetch(
      `${this.config.baseUrl}/copilot/conversations/${conversationId}/chatOverStream`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(buildChatRequestBody(userText, this.config.timeZone)),
        signal,
      },
    );
    if (!response.ok) {
      throw new GraphRequestError(response.status, await readBodyTail(response), LOGIN_COMMAND);
    }
    if (!response.body) throw new Error("Microsoft Graph returned an empty event stream");

    const parser = new SseParser();
    const decoder = new TextDecoder();
    // `fetch` body types loosely under @types/node here; narrow to the known
    // web-stream element type (runtime chunks are byte arrays).
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      const chunkEvents = done
        ? [...parser.push(decoder.decode()), ...parser.end()]
        : parser.push(decoder.decode(value, { stream: true }));
      for (const event of chunkEvents) {
        const message = this.extractFromEvent(event.data, userText);
        if (!message) continue;
        lastMessage = message;
        const chunk = tracker.advance(message.text ?? "");
        if (chunk) this.emit(sessionId, chunk);
      }
      if (done) break;
    }

    this.finishTurn(sessionId, tracker, lastMessage);
  }

  /**
   * Classify an error thrown during a turn.
   *
   * @returns `true` when the user cancelled (the caller reports `cancelled`).
   * @throws {TurnTimeoutError} when the turn hit its deadline.
   * @throws the original error otherwise.
   */
  private classifyTurnError(
    session: SessionState,
    controller: AbortController,
    err: unknown,
  ): true {
    if (session.cancelled) return true;
    if (controller.signal.reason === TURN_TIMEOUT_REASON) {
      throw new TurnTimeoutError(this.config.turnTimeoutMs);
    }
    throw err;
  }

  /**
   * Run a turn against the synchronous `chat` endpoint. Abort/timeout surface
   * as a thrown error that {@link prompt} classifies.
   *
   * @throws {GraphRequestError} on a non-2xx response.
   * @throws an `AbortError` when the shared signal is aborted (cancel/timeout).
   */
  private async runSyncTurn(
    sessionId: string,
    conversationId: string,
    token: string,
    userText: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(
      `${this.config.baseUrl}/copilot/conversations/${conversationId}/chat`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildChatRequestBody(userText, this.config.timeZone)),
        signal,
      },
    );
    if (!response.ok) {
      throw new GraphRequestError(response.status, await readBodyTail(response), LOGIN_COMMAND);
    }
    const snapshot = parseConversationSnapshot(await response.text());
    const message = extractResponseMessage(snapshot, userText);
    const text = cleanResponseText(message?.text ?? "");
    if (text) this.emit(sessionId, text);
    const attributions = renderAttributions(message);
    if (attributions) this.emit(sessionId, attributions);
    if (!text) this.emit(sessionId, EMPTY_OUTPUT_NOTE);
  }

  private extractFromEvent(data: string, userText: string): ConversationMessage | null {
    try {
      const snapshot = parseConversationSnapshot(data);
      return extractResponseMessage(snapshot, userText);
    } catch {
      // Tolerate keep-alive / non-JSON events; real payload errors surface as
      // an empty-output note at turn end.
      return null;
    }
  }

  private finishTurn(
    sessionId: string,
    tracker: SnapshotDeltaTracker,
    lastMessage: ConversationMessage | null,
  ): void {
    const rest = tracker.finalize();
    if (rest) this.emit(sessionId, rest);
    const attributions = renderAttributions(lastMessage);
    if (attributions) this.emit(sessionId, attributions);
    if (!tracker.hasOutput) this.emit(sessionId, EMPTY_OUTPUT_NOTE);
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
      version: CONVERSATION_SESSION_FILE_VERSION,
      sessionId,
      conversationId: session.conversationId,
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

async function readBodyTail(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, FAILURE_BODY_TAIL_CHARS);
  } catch {
    return "";
  }
}

async function runLogin(config: M365CopilotAdapterConfig): Promise<void> {
  if (config.staticToken !== null) {
    console.log("M365_COPILOT_STATIC_TOKEN is set — device-code login is not needed.");
    return;
  }
  const options = buildMsalOptions(config);
  const username = await loginWithDeviceCode(options, (instruction) => {
    console.log(instruction);
  });
  console.log(`Signed in as ${username} (token cache written to ${options.cacheFilePath})`);
}

async function runLogout(config: M365CopilotAdapterConfig): Promise<void> {
  const cacheFile = path.join(config.dataDir, MSAL_CACHE_FILE);
  await fs.promises.rm(cacheFile, { force: true });
  console.log(`Deleted token cache: ${cacheFile}`);
}

function serve(config: M365CopilotAdapterConfig): void {
  const problems = validateConfig(config);
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`${PROTOCOL_LOG_PREFIX} config error: ${problem}\n`);
    }
    process.exit(1);
  }

  // ACP over stdio: the bridge writes to our stdin, we answer on stdout.
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);
  new acp.AgentSideConnection((conn) => new M365CopilotAgent(conn, config), stream);
  process.stderr.write(
    `${PROTOCOL_LOG_PREFIX} ready (baseUrl=${config.baseUrl}, streaming=${String(config.streaming)})\n`,
  );
}

function main(): void {
  const config = loadConfig(process.env);
  const subcommand = process.argv[2];

  if (subcommand === "login") {
    runLogin(config).catch((err: unknown) => {
      console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
    return;
  }
  if (subcommand === "logout") {
    runLogout(config).catch((err: unknown) => {
      console.error(`Logout failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
    return;
  }
  serve(config);
}

main();
