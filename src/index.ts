/**
 * `lark-acp` — bridge a Lark bot to any ACP-compatible AI agent.
 *
 * Top-level exports:
 *
 * - {@link LarkBridge} — the orchestrator, instantiated once per process.
 * - {@link LarkLogger}, {@link createPinoLogger} — structured logging.
 * - {@link LarkPresenter}, {@link LarkCardPresenter} — pluggable UI surface.
 * - {@link SessionStore}, {@link FileSessionStore} — persistent chat → session mapping.
 */

export { LarkBridge } from "./bridge/bridge.js";
export type {
  LarkBridgeOptions,
  LarkBridgeLarkOptions,
  LarkBridgeAgentOptions,
  LarkBridgeSessionOptions,
  LarkToolsOptions,
} from "./bridge/bridge.js";

export {
  LarkToolServer,
  ToolContext,
  AskTimeoutError,
  registerLarkTools,
  LARK_TOOL_NAMES,
} from "./lark-tools/index.js";
export type {
  LarkToolServerOptions,
  ToolContextOptions,
  AskChoiceResult,
  DownloadedResource,
} from "./lark-tools/index.js";

export type { PermissionMode } from "./acp/lark-acp-client.js";
export { PERMISSION_MODES } from "./acp/lark-acp-client.js";

export type { LarkLogger } from "./logger/logger.js";
export { createPinoLogger } from "./logger/logger.js";

export type {
  AgentStatus,
  LarkPresenter,
  NoticeCardSpec,
  NoticeTemplate,
  TimelineEntry,
  ToolStatus,
  UnifiedCardState,
} from "./presenter/presenter.js";
export { LarkCardPresenter } from "./presenter/lark-presenter.js";
export type { LarkCardPresenterOptions } from "./presenter/lark-presenter.js";

export type { SessionStore, SessionRecord } from "./session-store/session-store.js";
export { FileSessionStore } from "./session-store/file-session-store.js";

export { AccessControl, FileAccessStore, DEFAULT_ACCESS_STATE } from "./access-control/index.js";
export type {
  AccessControlOptions,
  AccessDecision,
  AccessDenyReason,
  AccessRequest,
  AccessRole,
  AccessState,
  AccessStore,
  AccessTarget,
  ChatKind,
} from "./access-control/index.js";

export { Identity, IDENTITY_POLICIES, IDENTITY_ENV, isIdentityPolicy } from "./identity/index.js";
export type { IdentityOptions, IdentityPolicy, PromptContext } from "./identity/index.js";

export { LarkHttpClient } from "./lark/lark-http.js";
export type { LarkHttpOptions } from "./lark/lark-http.js";

export {
  LARK_DOMAINS,
  DEFAULT_LARK_DOMAIN,
  isLarkDomainName,
  resolveLarkDomain,
} from "./lark/domain.js";
export type { LarkDomainName, LarkDomainInput } from "./lark/domain.js";

export type { LarkWsKeepaliveOptions } from "./lark/lark-ws.js";
export type {
  LarkTransport,
  LarkTransportFactory,
  LarkTransportOptions,
  LarkConnectionStatus,
} from "./lark/transport.js";

export { LoggerAuditLogger } from "./audit/audit-logger.js";
export type { AuditEvent, AuditLogger } from "./audit/audit-logger.js";
