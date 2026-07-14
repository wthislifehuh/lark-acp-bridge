/**
 * Pure, side-effect-free core of the `lark-acp-m365` adapter: configuration,
 * SSE parsing, conversation-snapshot delta tracking, response-text cleanup,
 * and error classification for the Microsoft 365 Copilot Chat API
 * (Microsoft Graph, `/beta/copilot/conversations`).
 *
 * Kept separate from `m365-copilot-acp.ts` (the executable, which owns the
 * ACP connection and the HTTP calls) so unit tests can import these helpers
 * without running the bin's `main()`.
 */

import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { booleanEnv, envValue, positiveIntEnv } from "./env-config.js";

export const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/beta";
export const DEFAULT_TURN_TIMEOUT_MS = 300_000;

/**
 * The Chat API requires ALL of these delegated Graph permissions (per the
 * endpoint reference — the footnote marks the full set as required).
 */
export const DEFAULT_M365_COPILOT_SCOPES: readonly string[] = [
  "https://graph.microsoft.com/Sites.Read.All",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/People.Read.All",
  "https://graph.microsoft.com/OnlineMeetingTranscript.Read.All",
  "https://graph.microsoft.com/Chat.Read",
  "https://graph.microsoft.com/ChannelMessage.Read.All",
  "https://graph.microsoft.com/ExternalItem.Read.All",
];

const ATTRIBUTION_HEADER = "**引用来源**";

/**
 * Static, env-derived configuration. Resolved once at startup; users override
 * it through the preset's `env` block in `config.json`.
 */
export interface M365CopilotAdapterConfig {
  readonly tenantId: string | null;
  readonly appClientId: string | null;
  /** Entra authority host, e.g. https://login.microsoftonline.com */
  readonly authorityBase: string | null;
  readonly scopes: readonly string[];
  /** Graph base URL incl. version segment (overridable for tests). */
  readonly baseUrl: string;
  /** IANA time zone for the required `locationHint`. */
  readonly timeZone: string;
  /** Use `chatOverStream` (default) or the synchronous `chat` endpoint. */
  readonly streaming: boolean;
  readonly staticToken: string | null;
  readonly dataDir: string;
  readonly turnTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): M365CopilotAdapterConfig {
  const scopesRaw = envValue(env, "M365_COPILOT_SCOPES");
  const baseUrlRaw = envValue(env, "M365_COPILOT_BASE_URL") ?? DEFAULT_GRAPH_BASE_URL;
  return {
    tenantId: envValue(env, "M365_COPILOT_TENANT_ID"),
    appClientId: envValue(env, "M365_COPILOT_APP_CLIENT_ID"),
    authorityBase: envValue(env, "M365_COPILOT_AUTHORITY"),
    scopes:
      scopesRaw === null
        ? DEFAULT_M365_COPILOT_SCOPES
        : scopesRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    baseUrl: baseUrlRaw.endsWith("/") ? baseUrlRaw.slice(0, -1) : baseUrlRaw,
    timeZone:
      envValue(env, "M365_COPILOT_TIMEZONE") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    streaming: booleanEnv(env, "M365_COPILOT_STREAMING", true),
    staticToken: envValue(env, "M365_COPILOT_STATIC_TOKEN"),
    dataDir:
      envValue(env, "M365_COPILOT_DATA_DIR") ??
      path.join(os.homedir(), ".lark-acp", "m365-copilot"),
    turnTimeoutMs: positiveIntEnv(env, "M365_COPILOT_TURN_TIMEOUT_MS", DEFAULT_TURN_TIMEOUT_MS),
  };
}

/**
 * Return the list of configuration problems (empty = valid).
 */
export function validateConfig(config: M365CopilotAdapterConfig): string[] {
  const problems: string[] = [];
  if (config.staticToken !== null) return problems;
  if (config.tenantId === null) problems.push("缺少 M365_COPILOT_TENANT_ID");
  if (config.appClientId === null) problems.push("缺少 M365_COPILOT_APP_CLIENT_ID");
  return problems;
}

/** Body for `POST .../chat` and `POST .../chatOverStream`. */
export function buildChatRequestBody(
  text: string,
  timeZone: string,
): { message: { text: string }; locationHint: { timeZone: string } } {
  return { message: { text }, locationHint: { timeZone } };
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

/**
 * Minimal incremental `text/event-stream` parser (the subset Graph emits:
 * `data:` payloads with optional `event:`/`id:` fields, events separated by
 * blank lines). Feed decoded chunks; complete events come back in order.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const events: SseEvent[] = [];
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const rawEvent = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const parsed = parseSseBlock(rawEvent);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  /** Flush a trailing event not terminated by a blank line (stream end). */
  end(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    const parsed = parseSseBlock(rest);
    return parsed ? [parsed] : [];
  }
}

function parseSseBlock(block: string): SseEvent | null {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    } else if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    }
    // id:/retry:/comments are irrelevant here.
  }
  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join("\n") };
}

// ---------------------------------------------------------------------------
// Conversation snapshots (the JSON inside each SSE `data:` payload)
// ---------------------------------------------------------------------------

const attributionSchema = z
  .object({
    attributionType: z.string().optional(),
    providerDisplayName: z.string().optional(),
    seeMoreWebUrl: z.string().optional(),
  })
  .catchall(z.unknown());

const conversationMessageSchema = z
  .object({
    "@odata.type": z.string().optional(),
    id: z.string().optional(),
    text: z.string().optional(),
    attributions: z.array(attributionSchema).optional(),
  })
  .catchall(z.unknown());

const conversationSnapshotSchema = z
  .object({
    id: z.string().optional(),
    messages: z.array(conversationMessageSchema).optional(),
  })
  .catchall(z.unknown());

export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

/**
 * Parse one SSE `data:` payload / `chat` response body.
 *
 * @throws when the payload is not valid JSON or has an unexpected shape.
 */
export function parseConversationSnapshot(raw: string): ConversationSnapshot {
  return conversationSnapshotSchema.parse(JSON.parse(raw));
}

/**
 * Pick Copilot's reply out of a snapshot. Snapshots may also echo the user's
 * prompt as a message (same `@odata.type`), so the sent prompt text is used
 * to exclude it; the last remaining non-empty message wins.
 */
export function extractResponseMessage(
  snapshot: ConversationSnapshot,
  promptText: string,
): ConversationMessage | null {
  const messages = snapshot.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    const text = message.text ?? "";
    if (!text || text === promptText) continue;
    return message;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response-text cleanup
// ---------------------------------------------------------------------------

/**
 * Copilot's markdown embeds pseudo-entity tags and footnote markers that mean
 * nothing outside Microsoft's own renderers. Strip the documented tag set and
 * normalize `[^1^]` → `[1]`.
 */
const PSEUDO_ENTITY_TAG_PATTERN = /<\/?(Event|Person|File)>/g;
const FOOTNOTE_MARKER_PATTERN = /\[\^([^\]^]+)\^\]/g;

export function cleanResponseText(text: string): string {
  return text.replace(PSEUDO_ENTITY_TAG_PATTERN, "").replace(FOOTNOTE_MARKER_PATTERN, "[$1]");
}

/**
 * How far back to look for an unterminated pseudo-tag / footnote marker when
 * choosing a safe emission boundary. Longest token is `</Person>` (9 chars);
 * 40 gives ample slack for footnote labels.
 */
const HOLDBACK_WINDOW_CHARS = 40;

/**
 * Split pending text so the emitted part never ends inside an incomplete
 * `<Tag>` or `[^n^]` token (which would defeat {@link cleanResponseText}
 * when applied per-chunk).
 */
export function splitAtSafeBoundary(pending: string): { emit: string; hold: string } {
  const windowStart = Math.max(0, pending.length - HOLDBACK_WINDOW_CHARS);
  for (let i = pending.length - 1; i >= windowStart; i--) {
    const ch = pending[i];
    if (ch === "<" && !pending.includes(">", i)) {
      return { emit: pending.slice(0, i), hold: pending.slice(i) };
    }
    if (ch === "[" && !pending.includes("]", i)) {
      return { emit: pending.slice(0, i), hold: pending.slice(i) };
    }
  }
  return { emit: pending, hold: "" };
}

/**
 * Folds the stream of cumulative snapshot texts into append-only, cleaned
 * chunks. Graph's SSE events carry progressively longer versions of the same
 * response text; only the unseen suffix is emitted, with incomplete cleanup
 * tokens held back until they complete (or the turn is finalized).
 */
export class SnapshotDeltaTracker {
  /** Raw (uncleaned) response text already consumed from snapshots. */
  private consumedRaw = "";
  /** Raw text awaiting a safe emission boundary. */
  private pendingRaw = "";
  private emittedAnything = false;

  /** Whether any chunk was produced this turn. */
  get hasOutput(): boolean {
    return this.emittedAnything;
  }

  /** Feed the latest cumulative response text; returns the chunk to emit. */
  advance(cumulativeRaw: string): string {
    if (!cumulativeRaw.startsWith(this.consumedRaw)) {
      // Regressed / rewritten snapshot: trust what was already emitted and
      // wait for the stream to grow past it again.
      return "";
    }
    this.pendingRaw += cumulativeRaw.slice(this.consumedRaw.length);
    this.consumedRaw = cumulativeRaw;
    const { emit, hold } = splitAtSafeBoundary(this.pendingRaw);
    this.pendingRaw = hold;
    if (!emit) return "";
    this.emittedAnything = true;
    return cleanResponseText(emit);
  }

  /** Flush held-back text at stream end. */
  finalize(): string {
    const rest = this.pendingRaw;
    this.pendingRaw = "";
    if (!rest) return "";
    this.emittedAnything = true;
    return cleanResponseText(rest);
  }
}

// ---------------------------------------------------------------------------
// Attributions (citations)
// ---------------------------------------------------------------------------

/**
 * Render a message's citation attributions as a markdown block (or "" when
 * there is nothing meaningful to show). `annotation`-type attributions are
 * skipped — they duplicate inline links.
 */
export function renderAttributions(message: ConversationMessage | null): string {
  const attributions = message?.attributions ?? [];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const attribution of attributions) {
    if (attribution.attributionType !== "citation") continue;
    const url = attribution.seeMoreWebUrl ?? "";
    const name = attribution.providerDisplayName ?? "";
    const key = url || name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = name || `来源 ${String(lines.length + 1)}`;
    lines.push(
      url
        ? `${String(lines.length + 1)}. [${label}](${url})`
        : `${String(lines.length + 1)}. ${label}`,
    );
  }
  if (lines.length === 0) return "";
  return `\n\n${ATTRIBUTION_HEADER}\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * Human-readable (and bridge-recognizable) message for a Graph failure.
 * 401/403 messages start with "Authentication required" on purpose — the
 * bridge pattern-matches that prefix and stops retrying.
 */
export function describeGraphFailure(
  status: number,
  bodyTail: string,
  loginCommand: string,
): string {
  const detail = bodyTail ? `：${bodyTail}` : "";
  switch (status) {
    case HTTP_UNAUTHORIZED:
      return `Authentication required: Microsoft Graph 返回 401（token 无效/过期）。请重新运行 \`${loginCommand}\`${detail}`;
    case HTTP_FORBIDDEN:
      return (
        `Authentication required: Microsoft Graph 返回 403。` +
        `请确认登录用户拥有 Microsoft 365 Copilot 许可证、Entra 应用已获全部所需 Graph 权限（需管理员同意）${detail}`
      );
    case HTTP_NOT_FOUND:
      return `Microsoft Graph 返回 404：会话可能已过期或被删除，请发送 /new 重新开始${detail}`;
    case HTTP_TOO_MANY_REQUESTS:
      return `Microsoft Graph 返回 429（限流），请稍后重试${detail}`;
    default:
      return `Microsoft 365 Copilot Chat API 请求失败（HTTP ${String(status)}）${detail}`;
  }
}
