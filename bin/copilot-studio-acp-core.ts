/**
 * Pure, side-effect-free core of the `lark-acp-copilot-studio` adapter:
 * configuration, activity→text rendering, per-turn stream tracking, and
 * session-file (de)serialization.
 *
 * Kept separate from `copilot-studio-acp.ts` (the executable, which owns the
 * ACP connection and the Copilot Studio client lifecycle) so unit tests can
 * import these helpers without running the bin's `main()`.
 */

import path from "node:path";
import os from "node:os";
import { booleanEnv, envValue, positiveIntEnv } from "./env-config.js";

export const DEFAULT_TURN_TIMEOUT_MS = 300_000;
export const DEFAULT_POWER_PLATFORM_SCOPE = "https://api.powerplatform.com/.default";

export const AUTH_MODES = ["device-code", "client-secret", "static-token"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

const SUGGESTED_ACTIONS_LABEL = "**建议选项**";
const ATTACHMENT_NOTE = (count: number): string =>
  `_(收到 ${String(count)} 个卡片附件，Lark 卡片暂不渲染其内容)_`;

/** Blank line between separate messages of one turn. */
const MESSAGE_SEPARATOR = "\n\n";

/**
 * Static, env-derived configuration. Resolved once at startup; users override
 * it through the preset's `env` block in `config.json`.
 */
export interface CopilotStudioAdapterConfig {
  readonly environmentId: string | null;
  readonly schemaName: string | null;
  /** Copilot Studio "connection string" URL; overrides environment/schema. */
  readonly directConnectUrl: string | null;
  readonly tenantId: string | null;
  readonly appClientId: string | null;
  /** PowerPlatformCloud key, e.g. "Prod", "Gov", "Mooncake". */
  readonly cloud: string | null;
  /** "Published" (default) or "Prebuilt". */
  readonly agentType: string | null;
  readonly authMode: AuthMode;
  readonly clientSecret: string | null;
  readonly staticToken: string | null;
  /** Entra authority host, e.g. https://login.microsoftonline.com */
  readonly authorityBase: string | null;
  /** Token scopes override (comma-separated env). */
  readonly scopes: readonly string[] | null;
  /** BCP-47 locale forwarded when starting a conversation. */
  readonly locale: string | null;
  /** Whether to let the agent play its greeting topic on conversation start. */
  readonly emitStartEvent: boolean;
  readonly dataDir: string;
  readonly turnTimeoutMs: number;
}

function isAuthMode(value: string): value is AuthMode {
  return (AUTH_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the auth mode: explicit `COPILOT_STUDIO_AUTH_MODE` wins; otherwise
 * inferred from which credential material is present.
 *
 * @throws when an explicit mode is not one of {@link AUTH_MODES}.
 */
export function resolveAuthMode(
  explicit: string | null,
  hasStaticToken: boolean,
  hasClientSecret: boolean,
): AuthMode {
  if (explicit !== null) {
    if (!isAuthMode(explicit)) {
      throw new Error(
        `COPILOT_STUDIO_AUTH_MODE 必须是 ${AUTH_MODES.join(" / ")} 之一，收到 "${explicit}"`,
      );
    }
    return explicit;
  }
  if (hasStaticToken) return "static-token";
  if (hasClientSecret) return "client-secret";
  return "device-code";
}

export function loadConfig(env: NodeJS.ProcessEnv): CopilotStudioAdapterConfig {
  const staticToken = envValue(env, "COPILOT_STUDIO_STATIC_TOKEN");
  const clientSecret = envValue(env, "COPILOT_STUDIO_CLIENT_SECRET");
  const scopesRaw = envValue(env, "COPILOT_STUDIO_SCOPES");

  return {
    environmentId: envValue(env, "COPILOT_STUDIO_ENVIRONMENT_ID"),
    schemaName: envValue(env, "COPILOT_STUDIO_SCHEMA_NAME"),
    directConnectUrl: envValue(env, "COPILOT_STUDIO_DIRECT_CONNECT_URL"),
    tenantId: envValue(env, "COPILOT_STUDIO_TENANT_ID"),
    appClientId: envValue(env, "COPILOT_STUDIO_APP_CLIENT_ID"),
    cloud: envValue(env, "COPILOT_STUDIO_CLOUD"),
    agentType: envValue(env, "COPILOT_STUDIO_AGENT_TYPE"),
    authMode: resolveAuthMode(
      envValue(env, "COPILOT_STUDIO_AUTH_MODE"),
      staticToken !== null,
      clientSecret !== null,
    ),
    clientSecret,
    staticToken,
    authorityBase: envValue(env, "COPILOT_STUDIO_AUTHORITY"),
    scopes:
      scopesRaw === null
        ? null
        : scopesRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    locale: envValue(env, "COPILOT_STUDIO_LOCALE"),
    // Unset → true (agents commonly greet); explicit "false"/"0" disables.
    emitStartEvent: booleanEnv(env, "COPILOT_STUDIO_EMIT_START_EVENT", true),
    dataDir:
      envValue(env, "COPILOT_STUDIO_DATA_DIR") ??
      path.join(os.homedir(), ".lark-acp", "copilot-studio"),
    turnTimeoutMs: positiveIntEnv(env, "COPILOT_STUDIO_TURN_TIMEOUT_MS", DEFAULT_TURN_TIMEOUT_MS),
  };
}

/**
 * Return the list of configuration problems (empty = valid). Kept pure so the
 * bin can print all problems at once instead of failing one by one.
 */
export function validateConfig(config: CopilotStudioAdapterConfig): string[] {
  const problems: string[] = [];
  const hasDirect = config.directConnectUrl !== null;
  const hasEnvPair = config.environmentId !== null && config.schemaName !== null;
  if (!hasDirect && !hasEnvPair) {
    problems.push(
      "需要 COPILOT_STUDIO_DIRECT_CONNECT_URL，或同时提供 COPILOT_STUDIO_ENVIRONMENT_ID 与 COPILOT_STUDIO_SCHEMA_NAME（Copilot Studio → 设置 → 高级 → 元数据）",
    );
  }
  if (config.authMode === "device-code" || config.authMode === "client-secret") {
    if (config.tenantId === null) problems.push("缺少 COPILOT_STUDIO_TENANT_ID");
    if (config.appClientId === null) problems.push("缺少 COPILOT_STUDIO_APP_CLIENT_ID");
  }
  if (config.authMode === "client-secret" && config.clientSecret === null) {
    problems.push("authMode=client-secret 需要 COPILOT_STUDIO_CLIENT_SECRET");
  }
  if (config.authMode === "static-token" && config.staticToken === null) {
    problems.push("authMode=static-token 需要 COPILOT_STUDIO_STATIC_TOKEN");
  }
  return problems;
}

/**
 * Structural view of the SDK's `Activity` — only the fields the renderer
 * reads. Keeps this module free of the `@microsoft/agents-activity` runtime.
 */
export interface ActivityView {
  readonly type?: string | undefined;
  readonly text?: string | undefined;
  readonly suggestedActions?:
    | {
        readonly actions?:
          | readonly {
              readonly title?: string | undefined;
              readonly value?: unknown;
            }[]
          | undefined;
      }
    | undefined;
  readonly attachments?: readonly unknown[] | undefined;
  readonly entities?: readonly { readonly type?: string | undefined }[] | undefined;
  readonly channelData?: unknown;
  readonly conversation?: { readonly id?: string | undefined } | undefined;
}

export interface RenderedActivity {
  /** Text to append to the Lark card (already separator-prefixed). May be "". */
  readonly chunk: string;
  /** True when the agent closed the conversation (next prompt starts fresh). */
  readonly endOfConversation: boolean;
}

function renderSuggestedActions(activity: ActivityView): string {
  const actions = activity.suggestedActions?.actions ?? [];
  const labels = actions
    .map((a) => a.title ?? (typeof a.value === "string" ? a.value : ""))
    .filter((label) => label.length > 0);
  if (labels.length === 0) return "";
  return `${SUGGESTED_ACTIONS_LABEL}: ${labels.join(" / ")}`;
}

/**
 * Folds one turn's activity stream into append-only text chunks.
 *
 * Copilot Studio streams generative answers as `typing` activities whose text
 * the SDK client has already accumulated (each carries the cumulative text so
 * far), followed by a final `message` activity with the complete text. Plain
 * topics skip the typing phase and send whole `message` activities. This
 * tracker emits only the unseen suffix each time, so the bridge can append
 * chunks without ever re-rendering.
 */
export class ActivityRenderer {
  /** Cumulative text already emitted for the in-flight streamed message. */
  private streamedPrefix = "";
  private turnHasOutput = false;

  /** Whether any user-facing text was emitted this turn. */
  get hasOutput(): boolean {
    return this.turnHasOutput;
  }

  private separator(): string {
    return this.turnHasOutput && this.streamedPrefix === "" ? MESSAGE_SEPARATOR : "";
  }

  render(activity: ActivityView): RenderedActivity {
    switch (activity.type) {
      case "typing":
        return { chunk: this.renderTyping(activity), endOfConversation: false };
      case "message":
        return { chunk: this.renderMessage(activity), endOfConversation: false };
      case "endOfConversation":
        return { chunk: "", endOfConversation: true };
      default:
        // event / trace / conversationUpdate / ... carry no user-facing text.
        return { chunk: "", endOfConversation: false };
    }
  }

  private renderTyping(activity: ActivityView): string {
    const cumulative = activity.text ?? "";
    // Typing that hasn't grown past what we've shown is a pure progress
    // signal (covers the empty-text case too).
    if (!cumulative.startsWith(this.streamedPrefix)) return "";
    const delta = cumulative.slice(this.streamedPrefix.length);
    if (!delta) return "";
    const out = this.separator() + delta;
    this.streamedPrefix = cumulative;
    this.turnHasOutput = true;
    return out;
  }

  private renderMessage(activity: ActivityView): string {
    const full = activity.text ?? "";
    let remainder: string;
    if (full.startsWith(this.streamedPrefix)) {
      remainder = full.slice(this.streamedPrefix.length);
    } else {
      // Final text diverged from the streamed prefix (or a second, unrelated
      // message): trust what was already emitted, emit the new text only when
      // nothing streamed.
      remainder = this.streamedPrefix === "" ? full : "";
    }

    const parts: string[] = [];
    if (remainder) parts.push(this.separator() + remainder);

    const extras: string[] = [];
    const suggested = renderSuggestedActions(activity);
    if (suggested) extras.push(suggested);
    const attachmentCount = activity.attachments?.length ?? 0;
    if (attachmentCount > 0) extras.push(ATTACHMENT_NOTE(attachmentCount));

    const hadStreamed = this.streamedPrefix !== "";
    this.streamedPrefix = "";
    for (const extra of extras) {
      parts.push(
        parts.length > 0 || this.turnHasOutput || hadStreamed ? MESSAGE_SEPARATOR + extra : extra,
      );
    }

    const out = parts.join("");
    if (out) this.turnHasOutput = true;
    return out;
  }
}

/**
 * A non-2xx HTTP response captured by the adapter's fetch trap.
 *
 * Rationale: `eventsource-client` (used inside the Copilot Studio SDK) never
 * inspects HTTP status codes — a 401 would silently reconnect-loop forever.
 * The bin intercepts upstream responses, ends the stream cleanly, and records
 * the failure; this helper turns it into the user-facing error message.
 */
export interface UpstreamHttpFailure {
  readonly status: number;
  readonly url: string;
  readonly bodyTail: string;
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * Human-readable (and bridge-recognizable) message for an upstream failure.
 * 401/403 messages start with "Authentication required" on purpose — the
 * bridge pattern-matches that prefix and stops retrying.
 */
export function describeUpstreamFailure(
  failure: UpstreamHttpFailure,
  loginCommand: string,
): string {
  const detail = failure.bodyTail ? `：${failure.bodyTail}` : "";
  switch (failure.status) {
    case HTTP_UNAUTHORIZED:
    case HTTP_FORBIDDEN:
      return (
        `Authentication required: Copilot Studio 返回 ${String(failure.status)}` +
        `（token 无效/过期，或应用缺少 CopilotStudio.Copilots.Invoke 权限）。` +
        `请重新运行 \`${loginCommand}\` 并确认 Entra 应用权限${detail}`
      );
    case HTTP_NOT_FOUND:
      return `Copilot Studio 返回 404：请检查 environmentId / schemaName / directConnectUrl 是否正确、Agent 是否已发布${detail}`;
    case HTTP_TOO_MANY_REQUESTS:
      return `Copilot Studio 返回 429（限流），请稍后重试${detail}`;
    default:
      return `Copilot Studio 请求失败（HTTP ${String(failure.status)}）${detail}`;
  }
}
