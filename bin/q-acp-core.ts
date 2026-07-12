/**
 * Pure, side-effect-free core of the `lark-acp-q` adapter: configuration,
 * transcript shaping, `q chat` argv construction, and session-file parsing.
 *
 * Kept separate from `q-acp.ts` (the executable, which owns the process /
 * stream lifecycle) so unit tests can import these helpers without running
 * the bin's `main()`.
 */

import path from "node:path";
import os from "node:os";
import type * as acp from "@agentclientprotocol/sdk";

export const DEFAULT_Q_BIN = "q";
export const DEFAULT_WRAP = "never";
export const DEFAULT_MAX_HISTORY_MESSAGES = 24;
/**
 * Character budget for the replayed history. The whole input travels as a
 * single argv element, so it must stay well under the tightest OS limits
 * (Windows ~32K chars for the whole command line; Linux ~128KiB per arg).
 */
export const DEFAULT_MAX_HISTORY_CHARS = 24_000;

export const SESSION_FILE_VERSION = 1 as const;
export const SESSION_FILE_EXT = ".json";

export const HISTORY_HEADER = "=== 对话历史（仅供上下文参考，请勿重复回答历史中的旧问题）===";
export const CURRENT_HEADER = "=== 当前请求 ===";

export const ROLE_LABELS = { user: "用户", assistant: "助手" } as const;

export type Role = keyof typeof ROLE_LABELS;

export interface TranscriptMessage {
  readonly role: Role;
  readonly text: string;
}

/**
 * Static, env-derived configuration. Resolved once at startup; users override
 * it through the preset's `env` block in `config.json`.
 */
export interface QAdapterConfig {
  readonly bin: string;
  readonly model: string | null;
  readonly agent: string | null;
  /** `null` → pass `--trust-all-tools`; otherwise a `--trust-tools` CSV. */
  readonly trustTools: string | null;
  /** Value for `--wrap`; empty string omits the flag entirely. */
  readonly wrap: string;
  readonly extraArgs: readonly string[];
  readonly dataDir: string;
  readonly maxHistoryMessages: number;
  readonly maxHistoryChars: number;
}

/**
 * A `q chat` invocation failed. Carries the exit code and a tail of stderr so
 * the bridge can surface a useful message to the user.
 */
export class QChatError extends Error {
  readonly exitCode: number | null;
  readonly stderrTail: readonly string[];

  constructor(
    message: string,
    exitCode: number | null,
    stderrTail: readonly string[],
    options?: { cause?: unknown },
  ) {
    const suffix = stderrTail.length > 0 ? `\nstderr:\n${stderrTail.join("\n")}` : "";
    super(`${message}${suffix}`, options);
    this.name = "QChatError";
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/**
 * Strip ANSI CSI escape sequences (colour codes, cursor moves, line erases).
 * Amazon Q emits SGR colour codes even when its stdout is piped
 * (aws/amazon-q-developer-cli#993), and `NO_COLOR` does not fully suppress
 * them. Inlined on purpose: this one well-known regex is not worth a runtime
 * dependency the package would otherwise not need.
 *
 * ESC `[` (CSI) → params `[0-?]*` → intermediates `[ -/]*` → final `[@-~]`.
 */
const ANSI_CSI_PATTERN = /\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_CSI_PATTERN, "");
}

/** Flatten an ACP prompt into a single plain-text string for `q`. */
export function flattenPrompt(blocks: readonly acp.ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    // The Lark interpreter only ever emits text blocks (it lowers images /
    // files / etc. into text placeholders), so this is a defensive fallback.
    parts.push(`[${block.type} 内容已省略]`);
  }
  return parts.join("\n").trim();
}

/**
 * Compose the string handed to `q chat`: prior turns as reference context
 * followed by the current request. With no history, the raw request is used.
 */
export function buildQInput(transcript: readonly TranscriptMessage[], userText: string): string {
  if (transcript.length === 0) return userText;
  const lines: string[] = [HISTORY_HEADER];
  for (const message of transcript) {
    lines.push(`${ROLE_LABELS[message.role]}: ${message.text}`);
  }
  lines.push("", CURRENT_HEADER, userText);
  return lines.join("\n");
}

/**
 * Trim the transcript to the newest messages that fit BOTH caps: at most
 * `maxMessages` entries and at most `maxChars` total characters (history is
 * replayed as a single argv element — see {@link DEFAULT_MAX_HISTORY_CHARS}).
 * The result never leads with a dangling assistant reply.
 */
export function capHistory(
  transcript: readonly TranscriptMessage[],
  maxMessages: number,
  maxChars: number,
): TranscriptMessage[] {
  const kept: TranscriptMessage[] = [];
  let usedChars = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i];
    if (!message) continue; // unreachable within loop bounds; satisfies strict indexing
    if (kept.length >= maxMessages) break;
    if (usedChars + message.text.length > maxChars) break;
    usedChars += message.text.length;
    kept.unshift(message);
  }
  if (kept[0]?.role === "assistant") kept.shift();
  return kept;
}

/** Build the argv for a `q chat` invocation. `input` is the trailing positional. */
export function buildQArgs(config: QAdapterConfig, input: string): string[] {
  const args = ["chat", "--no-interactive"];
  if (config.wrap) args.push("--wrap", config.wrap);
  if (config.trustTools === null) args.push("--trust-all-tools");
  else args.push("--trust-tools", config.trustTools);
  if (config.model) args.push("--model", config.model);
  if (config.agent) args.push("--agent", config.agent);
  args.push(...config.extraArgs);
  // `--` guards against a prompt that happens to start with a dash.
  args.push("--", input);
  return args;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function positiveIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = envValue(env, key);
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv): QAdapterConfig {
  const extraRaw = envValue(env, "Q_ACP_EXTRA_ARGS");
  // Naive whitespace split — quoted arguments are not supported (documented).
  const extraArgs = extraRaw === null ? [] : extraRaw.split(/\s+/).filter(Boolean);

  // `Q_ACP_WRAP` unset → default "never"; explicitly empty → omit the flag.
  const wrapRaw = env["Q_ACP_WRAP"];
  const wrap = wrapRaw === undefined ? DEFAULT_WRAP : wrapRaw.trim();

  return {
    bin: envValue(env, "Q_ACP_BIN") ?? DEFAULT_Q_BIN,
    model: envValue(env, "Q_ACP_MODEL"),
    agent: envValue(env, "Q_ACP_AGENT"),
    trustTools: envValue(env, "Q_ACP_TRUST_TOOLS"),
    wrap,
    extraArgs,
    dataDir: envValue(env, "Q_ACP_DATA_DIR") ?? path.join(os.homedir(), ".lark-acp", "q-sessions"),
    maxHistoryMessages: positiveIntEnv(env, "Q_ACP_MAX_HISTORY", DEFAULT_MAX_HISTORY_MESSAGES),
    maxHistoryChars: positiveIntEnv(env, "Q_ACP_MAX_HISTORY_CHARS", DEFAULT_MAX_HISTORY_CHARS),
  };
}

export function sessionFilePath(dataDir: string, sessionId: string): string {
  // Session ids are UUIDs we mint, but sanitise defensively before touching FS.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(dataDir, `${safe}${SESSION_FILE_EXT}`);
}

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (obj["role"] === "user" || obj["role"] === "assistant") && typeof obj["text"] === "string";
}

/**
 * Parse a persisted session file.
 *
 * @throws when the payload is not valid JSON or does not match the expected
 *         shape — the caller treats this as "no resumable session".
 */
export function parseTranscriptFile(raw: string): TranscriptMessage[] {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("session file is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["version"] !== SESSION_FILE_VERSION) {
    throw new Error(`unsupported session file version: ${String(obj["version"])}`);
  }
  const transcript = obj["transcript"];
  if (!Array.isArray(transcript) || !transcript.every(isTranscriptMessage)) {
    throw new Error("session file has a malformed transcript");
  }
  return transcript;
}

const AUTH_FAILURE_PATTERN =
  /not logged in|token has expired|please (log ?in|sign ?in)|run `?q login/i;

/**
 * Detect Amazon Q auth failures in stderr so the error message can start with
 * "Authentication required" — the bridge's `isAuthenticationError` matches
 * `/auth(entication)? required/i` and then tears the runtime down instead of
 * pointlessly retrying (a re-login is needed either way).
 */
export function isQAuthFailure(stderrTail: readonly string[]): boolean {
  return stderrTail.some((line) => AUTH_FAILURE_PATTERN.test(line));
}
