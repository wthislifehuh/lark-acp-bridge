import * as Lark from "@larksuiteoapi/node-sdk";
import { createPinoLogger, type LarkLogger } from "../logger/logger.js";
import { LarkHttpClient } from "../lark/lark-http.js";
import { LarkWsConnection, type LarkWsKeepaliveOptions } from "../lark/lark-ws.js";
import type {
  LarkTransport,
  LarkTransportFactory,
  LarkTransportOptions,
} from "../lark/transport.js";
import type { LarkDomainInput } from "../lark/domain.js";
import { LoggerAuditLogger, type AuditLogger } from "../audit/audit-logger.js";
import { LarkCardPresenter } from "../presenter/lark-presenter.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import {
  interpretLarkMessage,
  type AccessCommandTarget,
  type InterpretedMessage,
  type LarkCommand,
} from "../interpreter/lark-interpreter.js";
import { ChatRuntime, type PendingMessage } from "./chat-runtime.js";
import { LarkToolServer } from "../lark-tools/lark-tool-server.js";
import type {
  CardActionClicker,
  CardActionResult,
  PermissionMode,
} from "../acp/lark-acp-client.js";
import type { AccessControl } from "../access-control/access-control.js";
import type { Identity, PromptContext } from "../identity/identity.js";
import type { NoticeCardSpec } from "../presenter/presenter.js";
import type { SessionStore } from "../session-store/session-store.js";
import type * as acp from "@agentclientprotocol/sdk";

const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_CONCURRENT_CHATS = 10;
const DEFAULT_SHOW_THOUGHTS = true;
const DEFAULT_SHOW_TOOLS = true;
const DEFAULT_SHOW_CANCEL_BUTTON = true;
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ASK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PERMISSION_MODE: PermissionMode = "alwaysAsk";
const IDLE_CLEANUP_INTERVAL_MS = 2 * 60_000;

const ORPHAN_CARD_REASON = "The session has ended — this approval request has expired";

const ACCESS_DISABLED_NOTICE: NoticeCardSpec = {
  title: "Access control disabled",
  body: "Access control is not enabled on this instance — every user who can see the bot may use it.",
  template: "grey",
};

const SENDER_TYPE_USER = "user";

/** Tenant id used in single-tenant mode — everything is still keyed by it. */
const DEFAULT_TENANT_ID = "default";
const CHAT_TYPE_GROUP = "group";

const COMMAND_NOTICES: Readonly<Record<"cancel" | "new", NoticeCardSpec>> = {
  cancel: {
    title: "Cancelled",
    body: "The current task was cancelled. The agent process is kept alive for follow-up messages.",
    template: "grey",
  },
  new: {
    title: "Session reset",
    body: "Your next message will start a brand-new agent session.",
    template: "green",
  },
};

function assertNever(x: never): never {
  throw new Error(`unexpected: ${String(x)}`);
}

function formatBootstrapError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause instanceof Error && cause.message) return `${err.message}\n→ ${cause.message}`;
  return err.message;
}

interface CardActionPayload {
  /** Permission request id (set on permission cards). */
  r?: string;
  /** Selected option id (set on permission cards). */
  o?: string;
  /** Option display name (set on permission cards). */
  n?: string;
  /** Tool kind (set on permission cards). */
  k?: string;
  /** Tool title (set on permission cards). */
  t?: string;
  /** Chat id — present on every card the bridge produces. */
  c?: string;
  /** Set on the unified card's "cancel current task" button. */
  cancel?: boolean;
  /** Ask id (set on `lark_ask_choice` interactive cards). */
  ask?: string;
  /** Selected option id (set on `lark_ask_choice` interactive cards). */
  opt?: string;
}

export interface LarkBridgeLarkOptions {
  appId: string;
  appSecret: string;
  /**
   * Deployment region (`"feishu"` | `"lark"`) or a custom base URL.
   * Defaults to the SDK's Feishu domain when omitted; apps on Lark
   * International must set `"lark"` or the server rejects the connection
   * with code `1000040351` ("Incorrect domain name").
   */
  domain?: LarkDomainInput;
  /** WebSocket liveness / reconnect tuning for unattended operation. */
  keepalive?: LarkWsKeepaliveOptions;
}

export interface LarkBridgeAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Optional preset id, used purely for logging context. */
  preset?: string;
  /** Include `agent_thought_chunk` content in the unified card. Default `true`. */
  showThoughts?: boolean;
  /** Include `tool_call` / `tool_call_update` events in the unified card. Default `true`. */
  showTools?: boolean;
  /**
   * Render the "Stop current task" button at the bottom of the running unified
   * card. When `false`, users can still cancel via `/cancel` chat command
   * but the in-card button is hidden. Default `true`.
   */
  showCancelButton?: boolean;
  /**
   * Auto-cancel a permission request if the user doesn't respond within
   * this many ms (0 = wait forever). Default 5 minutes.
   *
   * Without a timeout, an unanswered card will park its agent prompt
   * forever, preventing the chat runtime from being evicted.
   */
  permissionTimeoutMs?: number;
  /**
   * How to handle agent-side permission requests. Default `"alwaysAsk"`
   * (forwards the request to the user as a Lark card). `"alwaysAllow"` /
   * `"alwaysDeny"` auto-resolve without involving the user — useful for
   * trusted sandboxes or read-only deployments.
   */
  permissionMode?: PermissionMode;
}

export interface LarkBridgeSessionOptions {
  /** Evict an idle chat after this many ms (0 = never). Default 24h. */
  idleTimeoutMs?: number;
  /** Maximum chats kept in memory; oldest idle gets evicted. Default 10. */
  maxConcurrentChats?: number;
}

export interface LarkToolsOptions {
  /**
   * Enable the in-process Lark MCP tool server, giving the agent a reverse
   * channel into Lark (ask the user a question, download an attachment).
   * Default `false`. Only injected into agents advertising HTTP MCP support.
   * See `docs/lark-mcp-tool-server.md`.
   */
  enabled: boolean;
  /** Auto-fail a blocking interactive tool after this many ms (0 = never). Default 5 min. */
  askTimeoutMs?: number;
}

export interface LarkBridgeOptions {
  lark: LarkBridgeLarkOptions;
  agent: LarkBridgeAgentOptions;
  session?: LarkBridgeSessionOptions;

  /**
   * In-process Lark MCP tool server. When omitted or disabled the agent has
   * no reverse channel into Lark (today's behaviour).
   */
  tools?: LarkToolsOptions;

  sessionStore: SessionStore;

  /**
   * Access control governing who may drive the bot. When omitted the bridge
   * is **open** — every user in the app's availability scope can use it, and
   * permission cards are resolvable by anyone (legacy behaviour). Supply an
   * {@link AccessControl} to enforce private-by-default + allowlists.
   */
  accessControl?: AccessControl;

  /**
   * `lark-cli` identity policy + prompt-context injection. When omitted the
   * bridge falls back to its built-in minimal context block and injects no
   * identity environment variables.
   */
  identity?: Identity;

  /**
   * Explicit tenant id. Defaults to `"default"` in single-tenant mode — all
   * logs and audit records are keyed by it, so a multi-tenant deployment can
   * run one bridge per tenant without a rewrite (Phase-2 groundwork).
   */
  tenantId?: string;

  /**
   * Factory for the inbound-event transport. Defaults to the WebSocket long
   * connection ({@link LarkWsConnection}); inject a custom one (e.g. an
   * ISV/webhook receiver) to change how events arrive.
   */
  transportFactory?: LarkTransportFactory;

  /**
   * Sink for security-relevant audit events. Defaults to a
   * {@link LoggerAuditLogger} writing through {@link logger}.
   */
  auditLogger?: AuditLogger;

  /** Override the default pino-backed logger. */
  logger?: LarkLogger;
  /**
   * Override the default {@link LarkCardPresenter}. When omitted the bridge
   * builds one from `lark.appId` / `lark.appSecret`.
   */
  presenter?: LarkPresenter;
}

/**
 * Top-level bridge that connects a Lark bot to an ACP agent.
 *
 * Owns: Lark HTTP client, Lark WebSocket subscription, logger, presenter,
 * session store handle, and one {@link ChatRuntime} per active chat.
 *
 * Lifecycle:
 *
 * 1. `new LarkBridge(opts)` — wires dependencies, no IO yet.
 * 2. `await bridge.start()` — initialises the session store and opens
 *    the WebSocket subscription.
 * 3. `await bridge.stop()` — shuts down all chat runtimes and the store.
 */
export class LarkBridge {
  private readonly logger: LarkLogger;
  private readonly http: LarkHttpClient;
  private readonly presenter: LarkPresenter;
  private readonly sessionStore: SessionStore;
  private readonly agentOpts: Required<Omit<LarkBridgeAgentOptions, "env" | "preset">> &
    Pick<LarkBridgeAgentOptions, "env" | "preset">;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrentChats: number;
  private readonly lark: LarkBridgeLarkOptions;
  private readonly accessControl: AccessControl | null;
  private readonly identity: Identity | null;
  private readonly tenantId: string;
  private readonly transportFactory: LarkTransportFactory;
  private readonly audit: AuditLogger;
  private readonly toolServer: LarkToolServer | null;

  private readonly chats = new Map<string, ChatRuntime>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ws: LarkTransport | null = null;
  private started = false;

  constructor(opts: LarkBridgeOptions) {
    this.lark = opts.lark;
    this.tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
    // Tenant-tag every log line the bridge and its children emit.
    this.logger = (opts.logger ?? createPinoLogger()).child({
      name: "bridge",
      tenantId: this.tenantId,
    });
    this.sessionStore = opts.sessionStore;
    this.audit = opts.auditLogger ?? new LoggerAuditLogger(this.logger, this.tenantId);
    this.transportFactory =
      opts.transportFactory ??
      ((o: LarkTransportOptions) =>
        new LarkWsConnection({
          ...o,
          ...(this.lark.keepalive !== undefined ? { keepalive: this.lark.keepalive } : {}),
        }));

    this.http = new LarkHttpClient({
      appId: opts.lark.appId,
      appSecret: opts.lark.appSecret,
      ...(opts.lark.domain !== undefined ? { domain: opts.lark.domain } : {}),
      logger: this.logger,
    });

    this.presenter =
      opts.presenter ?? new LarkCardPresenter({ http: this.http, logger: this.logger });

    this.agentOpts = {
      command: opts.agent.command,
      args: opts.agent.args,
      cwd: opts.agent.cwd,
      env: opts.agent.env,
      preset: opts.agent.preset,
      showThoughts: opts.agent.showThoughts ?? DEFAULT_SHOW_THOUGHTS,
      showTools: opts.agent.showTools ?? DEFAULT_SHOW_TOOLS,
      showCancelButton: opts.agent.showCancelButton ?? DEFAULT_SHOW_CANCEL_BUTTON,
      permissionTimeoutMs: opts.agent.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
      permissionMode: opts.agent.permissionMode ?? DEFAULT_PERMISSION_MODE,
    };

    this.idleTimeoutMs = opts.session?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxConcurrentChats = opts.session?.maxConcurrentChats ?? DEFAULT_MAX_CONCURRENT_CHATS;
    this.accessControl = opts.accessControl ?? null;
    this.identity = opts.identity ?? null;
    this.toolServer = opts.tools?.enabled
      ? new LarkToolServer({
          http: this.http,
          logger: this.logger,
          askTimeoutMs: opts.tools.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
        })
      : null;
  }

  /**
   * Initialise the session store and open the Lark WebSocket subscription.
   *
   * @throws when the session store fails to initialise, or the WebSocket
   *         connection fails to establish (bad credentials, network error).
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      await this.sessionStore.init();
      await this.accessControl?.init();
      await this.toolServer?.start();

      this.cleanupTimer = setInterval(() => {
        this.evictIdle();
      }, IDLE_CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref();

      this.ws = this.transportFactory({
        appId: this.lark.appId,
        appSecret: this.lark.appSecret,
        ...(this.lark.domain !== undefined ? { domain: this.lark.domain } : {}),
        logger: this.logger,
        onMessage: (event) => {
          this.handleMessage(event);
        },
        onCardAction: (event) => {
          this.handleCardAction(event);
        },
      });
      await this.ws.start();
    } catch (err) {
      if (this.cleanupTimer) clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      this.ws = null;
      await this.toolServer?.stop().catch(() => undefined);
      this.started = false;
      throw err;
    }

    this.logger.info("bridge started");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.logger.info("stopping bridge");
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.ws?.stop();
    this.ws = null;
    for (const runtime of this.chats.values()) runtime.shutdown();
    this.chats.clear();
    await this.toolServer?.stop();
    await this.sessionStore.close();
    await this.accessControl?.close();
    this.started = false;
    this.logger.info("bridge stopped");
  }

  /** Active chat runtime count (mostly for tests / metrics). */
  get activeChatCount(): number {
    return this.chats.size;
  }

  // ----- WS event handlers ------------------------------------------------

  private handleMessage(event: Lark.RawMessageEvent): void {
    const { message, sender } = event;
    if (sender.sender_type !== SENDER_TYPE_USER) return;

    const userId = sender.sender_id.open_id;
    const messageId = message.message_id;
    const chatId = message.chat_id;
    if (!userId || !messageId || !chatId) return;

    this.logger.info({ userId, chatId, messageType: message.message_type }, "message received");

    this.routeMessage(event, userId, messageId, chatId).catch((err: unknown) => {
      this.logger.error({ err, chatId }, "routeMessage failed");
    });
  }

  private async routeMessage(
    event: Lark.RawMessageEvent,
    userId: string,
    messageId: string,
    chatId: string,
  ): Promise<void> {
    const { message } = event;
    const isGroup = message.chat_type === CHAT_TYPE_GROUP;

    let botOpenId: string | undefined;
    if (isGroup) {
      try {
        botOpenId = await this.http.getBotOpenId();
      } catch (err) {
        // Without our own open_id we can't tell who is mentioned — drop the
        // event rather than risk treating every group message as addressed
        // to us. The next message will retry.
        this.logger.warn({ err, chatId }, "getBotOpenId failed — skipping group message");
        return;
      }
      const requireMention = this.accessControl?.requireMentionInGroup() ?? true;
      if (requireMention) {
        const mentioned = message.mentions?.some((m) => m.id.open_id === botOpenId);
        if (!mentioned) {
          this.logger.debug({ chatId }, "skipping group message — bot not mentioned");
          return;
        }
      }
    }

    if (!this.checkAccess(userId, chatId, isGroup)) return;

    const interpreted: InterpretedMessage = interpretLarkMessage(event, { botOpenId });
    switch (interpreted.kind) {
      case "empty":
        return;
      case "command":
        await this.handleCommand(interpreted.command, chatId, messageId, userId);
        return;
      case "prompt":
        await this.enqueueWithContext(event, chatId, userId, messageId, interpreted.blocks);
        return;
      default:
        return assertNever(interpreted);
    }
  }

  /**
   * Evaluate access control for an inbound message. Returns `true` when the
   * message may be handled. Emits an audit-tagged log line for every
   * decision. When no access control is configured the bridge is open.
   */
  private checkAccess(userId: string, chatId: string, isGroup: boolean): boolean {
    const ac = this.accessControl;
    if (!ac) return true;

    const decision = ac.evaluateMessage({
      openId: userId,
      chatId,
      chatType: isGroup ? "group" : "p2p",
    });

    if (decision.allowed) {
      this.audit.record({
        action: decision.ownerClaimed ? "access.owner_claimed" : "access.granted",
        chatId,
        operatorOpenId: userId,
        outcome: "allowed",
        detail: { role: decision.role },
      });
      return true;
    }

    this.audit.record({
      action: "access.denied",
      chatId,
      operatorOpenId: userId,
      outcome: "denied",
      detail: { reason: decision.reason },
    });
    return false;
  }

  private async handleCommand(
    command: LarkCommand,
    chatId: string,
    messageId: string,
    userId: string,
  ): Promise<void> {
    switch (command.kind) {
      case "cancel": {
        this.logger.info({ chatId }, "cancel command");
        const runtime = this.chats.get(chatId);
        try {
          await runtime?.cancel();
        } catch (err) {
          this.logger.warn({ err, chatId }, "cancel command failed");
        }
        await this.presenter.replyNoticeCard(messageId, COMMAND_NOTICES.cancel);
        return;
      }
      case "new": {
        this.logger.info({ chatId }, "new session command");
        const runtime = this.chats.get(chatId);
        runtime?.shutdown();
        this.chats.delete(chatId);
        this.unregisterTools(chatId);
        await this.presenter.replyNoticeCard(messageId, COMMAND_NOTICES.new);
        return;
      }
      case "help":
        await this.handleHelp(messageId, userId);
        return;
      case "status":
        await this.handleStatus(chatId, userId, messageId);
        return;
      case "config":
        await this.handleConfig(userId, messageId);
        return;
      case "access-show":
        await this.handleAccessShow(messageId);
        return;
      case "access-usage":
        await this.presenter.replyNoticeCard(messageId, {
          title: "Command usage",
          body: command.usage,
          template: "blue",
        });
        return;
      case "mention-toggle":
        await this.handleMentionToggle(command.enabled, userId, messageId);
        return;
      case "invite":
      case "remove":
        await this.handleAccessMutation(command.kind, command.target, chatId, userId, messageId);
        return;
      default:
        return assertNever(command);
    }
  }

  // ----- Operability commands ---------------------------------------------

  private async handleHelp(messageId: string, userId: string): Promise<void> {
    const privileged = this.accessControl?.isPrivileged(userId) ?? true;
    const lines = [
      "**General commands**",
      "- `/help` — show this help",
      "- `/status` — show the current session and identity status",
      "- `/cancel` · `/stop` — stop the current task (keeps the agent process)",
      "- `/new` · `/restart` — reset the session; the next message starts a fresh agent session",
    ];
    if (privileged) {
      lines.push(
        "",
        "**Admin commands (owner / admin)**",
        "- `/config` — show the runtime configuration",
        "- `/access` — show the access-control lists",
        "- `/invite user @user…` · `/invite admin @user…` — add to the user / admin allowlist",
        "- `/invite group` — authorize the current group chat",
        "- `/remove user @user…` · `/remove admin @user…` · `/remove group` — revoke access",
        "- `/mention on` · `/mention off` — whether group chats require an @mention",
      );
    }
    lines.push("", "In a group chat, @mention the bot before typing a command.");
    await this.presenter.replyNoticeCard(messageId, {
      title: "Command help",
      body: lines.join("\n"),
      template: "blue",
    });
  }

  private async handleStatus(chatId: string, userId: string, messageId: string): Promise<void> {
    const runtime = this.chats.get(chatId);
    const sessionState = !runtime
      ? "no active session"
      : runtime.processing
        ? "running"
        : "idle (process kept alive)";
    const role = this.accessControl
      ? this.accessControl.roleOf(userId)
      : "(access control disabled)";
    const identity = this.identity ? this.identity.policy : "(not configured)";

    const body = [
      `**Your role**: ${role}`,
      `**Tenant**: ${this.tenantId}`,
      `**Agent**: ${this.describeAgentLabel()}`,
      `**Session**: ${sessionState}`,
      `**Connection**: ${this.describeConnection()}`,
      `**Identity policy**: ${identity}`,
      `**Permission mode**: ${this.agentOpts.permissionMode}`,
      `**Active sessions**: ${this.chats.size} / ${this.maxConcurrentChats}`,
    ].join("\n");
    await this.presenter.replyNoticeCard(messageId, {
      title: "Status",
      body,
      template: "blue",
    });
  }

  /** WebSocket connection state for `/status`, e.g. `connected` or `reconnecting (2 attempts)`. */
  private describeConnection(): string {
    const status = this.ws?.getConnectionStatus();
    if (!status) return "unknown";
    return status.reconnectAttempts > 0
      ? `${status.state} (${status.reconnectAttempts} reconnect attempts)`
      : status.state;
  }

  private async handleConfig(userId: string, messageId: string): Promise<void> {
    const ac = await this.requirePrivilegedAccess(userId, messageId);
    if (!ac) return;

    const onOff = (v: boolean): string => (v ? "on" : "off");
    const s = ac.snapshot();
    const owner = s.effectiveOwner ?? "(not set)";
    const body = [
      "**Display**",
      `- Thoughts: ${onOff(this.agentOpts.showThoughts)}`,
      `- Tool calls: ${onOff(this.agentOpts.showTools)}`,
      `- Stop button: ${onOff(this.agentOpts.showCancelButton)}`,
      "",
      "**Permissions / identity**",
      `- Tool permission mode: ${this.agentOpts.permissionMode}`,
      `- Identity policy: ${this.identity ? this.identity.policy : "(not configured)"}`,
      "",
      "**Access control**",
      `- Owner: ${owner}`,
      `- Admins: ${s.admins.length} | Users: ${s.users.length} | Groups: ${s.groups.length}`,
      `- Group chats require @mention: ${s.requireMentionInGroup ? "yes" : "no"}`,
    ].join("\n");
    await this.presenter.replyNoticeCard(messageId, {
      title: "Runtime configuration",
      body,
      template: "blue",
    });
  }

  /** Human-readable agent label for `/status` — preset id when set, else the command. */
  private describeAgentLabel(): string {
    if (this.agentOpts.preset !== undefined) return this.agentOpts.preset;
    const { command, args } = this.agentOpts;
    return args.length > 0 ? `${command} ${args.join(" ")}` : command;
  }

  // ----- Access-control commands ------------------------------------------

  private async handleMentionToggle(
    enabled: boolean,
    userId: string,
    messageId: string,
  ): Promise<void> {
    const ac = await this.requirePrivilegedAccess(userId, messageId);
    if (!ac) return;
    ac.setRequireMentionInGroup(enabled);
    this.audit.record({
      action: "access.mention_toggle",
      operatorOpenId: userId,
      detail: { enabled },
    });
    await this.presenter.replyNoticeCard(messageId, {
      title: "Updated",
      body: enabled
        ? "The bot now only responds in group chats when it is @mentioned."
        : "The bot now responds in group chats without an @mention (the group allowlist still applies).",
      template: "green",
    });
  }

  private async handleAccessMutation(
    kind: "invite" | "remove",
    target: AccessCommandTarget,
    chatId: string,
    userId: string,
    messageId: string,
  ): Promise<void> {
    const ac = await this.requirePrivilegedAccess(userId, messageId);
    if (!ac) return;

    const notice =
      kind === "invite"
        ? await this.applyInvite(ac, target, chatId)
        : await this.applyRemove(ac, target, chatId);
    this.audit.record({
      action: kind === "invite" ? "access.grant" : "access.revoke",
      chatId,
      operatorOpenId: userId,
      outcome: kind === "invite" ? "granted" : "revoked",
      detail: { target: target.type },
    });
    await this.presenter.replyNoticeCard(messageId, notice);
  }

  private async applyInvite(
    ac: AccessControl,
    target: AccessCommandTarget,
    chatId: string,
  ): Promise<NoticeCardSpec> {
    switch (target.type) {
      case "group": {
        const added = ac.grantGroup(chatId);
        return {
          title: added ? "Group chat authorized" : "Group chat already allowlisted",
          body: `chat_id: ${chatId}`,
          template: added ? "green" : "grey",
        };
      }
      case "user":
      case "admin": {
        const added =
          target.type === "user" ? ac.grantUsers(target.openIds) : ac.grantAdmins(target.openIds);
        const label = target.type === "user" ? "users" : "admins";
        if (added.length === 0) {
          return {
            title: "No change",
            body: `The selected ${label} are already on the list.`,
            template: "grey",
          };
        }
        const names = await this.resolveNames(added);
        return { title: `Added ${label}`, body: names.join("\n"), template: "green" };
      }
      default:
        return assertNever(target);
    }
  }

  private async applyRemove(
    ac: AccessControl,
    target: AccessCommandTarget,
    chatId: string,
  ): Promise<NoticeCardSpec> {
    switch (target.type) {
      case "group": {
        const removed = ac.revokeGroup(chatId);
        return {
          title: removed ? "Group chat access revoked" : "Group chat not allowlisted",
          body: `chat_id: ${chatId}`,
          template: removed ? "orange" : "grey",
        };
      }
      case "user":
      case "admin": {
        const removed =
          target.type === "user" ? ac.revokeUsers(target.openIds) : ac.revokeAdmins(target.openIds);
        const label = target.type === "user" ? "users" : "admins";
        if (removed.length === 0) {
          return {
            title: "No change",
            body: `The selected ${label} are not on the list (the owner cannot be removed).`,
            template: "grey",
          };
        }
        const names = await this.resolveNames(removed);
        return { title: `Removed ${label}`, body: names.join("\n"), template: "orange" };
      }
      default:
        return assertNever(target);
    }
  }

  private async handleAccessShow(messageId: string): Promise<void> {
    const ac = this.accessControl;
    if (!ac) {
      await this.presenter.replyNoticeCard(messageId, ACCESS_DISABLED_NOTICE);
      return;
    }
    const s = ac.snapshot();
    const ownerLine = s.effectiveOwner
      ? (await this.resolveNames([s.effectiveOwner]))[0]
      : "(not set — the first direct-message user becomes the owner)";
    const admins = s.admins.length > 0 ? (await this.resolveNames(s.admins)).join("\n") : "(none)";
    const users = s.users.length > 0 ? (await this.resolveNames(s.users)).join("\n") : "(none)";
    const groups = s.groups.length > 0 ? s.groups.join("\n") : "(none)";
    const body = [
      `**Owner**: ${ownerLine}`,
      `**Admins**:\n${admins}`,
      `**Users (direct-message allowlist)**:\n${users}`,
      `**Groups (group allowlist)**:\n${groups}`,
      `**Group chats require @mention**: ${s.requireMentionInGroup ? "yes" : "no"}`,
    ].join("\n\n");
    await this.presenter.replyNoticeCard(messageId, {
      title: "Access control",
      body,
      template: "blue",
    });
  }

  /**
   * Resolve access control for a privileged command. Replies with a notice
   * and returns `null` when access control is disabled or the caller isn't
   * an owner/admin; otherwise returns the {@link AccessControl}.
   */
  private async requirePrivilegedAccess(
    userId: string,
    messageId: string,
  ): Promise<AccessControl | null> {
    const ac = this.accessControl;
    if (!ac) {
      await this.presenter.replyNoticeCard(messageId, ACCESS_DISABLED_NOTICE);
      return null;
    }
    if (!ac.isPrivileged(userId)) {
      this.audit.record({
        action: "access.command_denied",
        operatorOpenId: userId,
        outcome: "denied",
      });
      await this.presenter.replyNoticeCard(messageId, {
        title: "Not permitted",
        body: "Only the bot owner / admins can run access-control commands.",
        template: "red",
      });
      return null;
    }
    return ac;
  }

  /** Resolve `open_id`s to `"Name (open_id)"` display strings. */
  private async resolveNames(openIds: readonly string[]): Promise<string[]> {
    return Promise.all(openIds.map(async (id) => `${await this.http.getUserName(id)} (${id})`));
  }

  private async enqueueWithContext(
    event: Lark.RawMessageEvent,
    chatId: string,
    userId: string,
    messageId: string,
    prompt: acp.ContentBlock[],
  ): Promise<void> {
    const runtime = this.acquireRuntime(chatId);
    // Bind interactive tool cards (ask_choice) to the current operator so
    // only they can answer — reuses the permission-card operator rule.
    this.toolServer?.contextForChat(chatId)?.setOperator(userId);

    if (runtime.needsContext(userId)) {
      const isGroup = event.message.chat_type === CHAT_TYPE_GROUP;
      const [userName, chatName] = await Promise.all([
        this.http.getUserName(userId),
        isGroup ? this.http.getChatName(chatId) : Promise.resolve(""),
      ]);

      const context = this.buildPromptContext({
        chatType: isGroup ? "group" : "p2p",
        chatId,
        chatName,
        userId,
        userName,
      });
      if (context) prompt.unshift({ type: "text", text: context });
    }

    const pending: PendingMessage = { prompt, messageId, chatId, userId };
    try {
      await runtime.enqueue(pending);
    } catch (err) {
      // bootstrap (spawn / initialize / newSession / resume) failed — the
      // ChatRuntime never registered itself as active, so drop it and let
      // the next message try again from scratch.
      this.chats.delete(chatId);
      this.unregisterTools(chatId);
      this.logger.error({ err, chatId }, "agent bootstrap failed");
      const summary = `⚠️ Agent failed to start: ${formatBootstrapError(err)}`;
      await this.presenter.replyText(messageId, summary).catch((sendErr: unknown) => {
        this.logger.warn({ err: sendErr }, "bootstrap error reply failed");
      });
    }
  }

  private acquireRuntime(chatId: string): ChatRuntime {
    const existing = this.chats.get(chatId);
    if (existing) return existing;

    if (this.chats.size >= this.maxConcurrentChats) this.evictOldest();

    const mcpServers = this.toolServer ? [this.toolServer.register(chatId)] : undefined;
    const runtime = new ChatRuntime({
      chatId,
      agentCommand: this.agentOpts.command,
      agentArgs: this.agentOpts.args,
      agentCwd: this.agentOpts.cwd,
      agentEnv: this.buildAgentEnv(chatId),
      showThoughts: this.agentOpts.showThoughts,
      showTools: this.agentOpts.showTools,
      showCancelButton: this.agentOpts.showCancelButton,
      permissionTimeoutMs: this.agentOpts.permissionTimeoutMs,
      permissionMode: this.agentOpts.permissionMode,
      presenter: this.presenter,
      sessionStore: this.sessionStore,
      logger: this.logger,
      ...(mcpServers !== undefined ? { mcpServers } : {}),
    });
    this.chats.set(chatId, runtime);
    return runtime;
  }

  /** Preset env plus any identity-injected `LARK_ACP_*` variables for this chat. */
  private buildAgentEnv(chatId: string): Record<string, string> | undefined {
    if (!this.identity) return this.agentOpts.env;
    return { ...(this.agentOpts.env ?? {}), ...this.identity.agentEnv(chatId) };
  }

  /**
   * The prompt-context block prepended to a prompt. Delegates to the
   * {@link Identity} component when present; otherwise falls back to the
   * built-in minimal block (preserving legacy behaviour).
   */
  private buildPromptContext(ctx: PromptContext): string | null {
    if (this.identity) return this.identity.promptContext(ctx);
    return ctx.chatType === "group"
      ? `[Context: message from ${ctx.userName} (${ctx.userId}) in group chat "${ctx.chatName ?? ""}" (${ctx.chatId})]`
      : `[Context: direct message from ${ctx.userName} (${ctx.userId})]`;
  }

  private handleCardAction(event: Lark.CardActionEvent): void {
    const value = event.action.value as CardActionPayload | undefined;
    if (!value?.c) return;

    if (value.cancel === true) {
      this.handleCancelButton(value.c);
      return;
    }

    if (value.ask && value.opt) {
      const clicker: CardActionClicker = {
        openId: event.operator.openId,
        privileged: this.accessControl?.isPrivileged(event.operator.openId) ?? false,
      };
      this.handleAskCardAction(value.c, value.ask, value.opt, clicker);
      return;
    }

    if (!value.r || !value.o) return;
    const clicker: CardActionClicker = {
      openId: event.operator.openId,
      privileged: this.accessControl?.isPrivileged(event.operator.openId) ?? false,
    };
    this.handlePermissionCardAction(
      event,
      value.c,
      value.r,
      value.o,
      value.n,
      value.k,
      value.t,
      clicker,
    );
  }

  /**
   * Route a `lark_ask_choice` card click to the chat's tool context. The
   * context patches its own card on resolve; the bridge only records the
   * outcome and rejects non-operator clicks (operator binding lives in
   * {@link ToolContext.resolveAsk}).
   */
  private handleAskCardAction(
    chatId: string,
    askId: string,
    optionId: string,
    clicker: CardActionClicker,
  ): void {
    const result = this.toolServer?.resolveAsk(chatId, askId, optionId, clicker) ?? "orphan";
    if (result === "forbidden") {
      this.audit.record({
        action: "tool.ask_rejected",
        chatId,
        operatorOpenId: clicker.openId,
        outcome: "denied",
        detail: { askId, reason: "not_originating_operator" },
      });
      return;
    }
    if (result === "orphan") {
      this.logger.info({ chatId, askId }, "orphan ask-card action");
      return;
    }
    this.audit.record({
      action: "tool.ask_answered",
      chatId,
      operatorOpenId: clicker.openId,
      outcome: "answered",
      detail: { askId, optionId },
    });
  }

  private handleCancelButton(chatId: string): void {
    const runtime = this.chats.get(chatId);
    if (!runtime) {
      this.logger.info({ chatId }, "cancel button clicked but no active runtime");
      return;
    }
    this.logger.info({ chatId }, "cancel button clicked");
    runtime.cancel().catch((err: unknown) => {
      this.logger.warn({ err, chatId }, "cancel via card button failed");
    });
  }

  private handlePermissionCardAction(
    event: Lark.CardActionEvent,
    chatId: string,
    requestId: string,
    optionId: string,
    optionName: string | undefined,
    toolKind: string | undefined,
    toolTitle: string | undefined,
    clicker: CardActionClicker,
  ): void {
    const runtime = this.chats.get(chatId);
    const result: CardActionResult =
      runtime?.handleCardAction(requestId, optionId, clicker) ?? "orphan";
    const messageId = event.messageId;

    if (result === "forbidden") {
      // §4.1: a non-originating, non-privileged user tried to resolve someone
      // else's permission card. Reject silently and leave the card pending so
      // the rightful operator can still act.
      this.audit.record({
        action: "tool.authorization_rejected",
        chatId,
        operatorOpenId: clicker.openId,
        outcome: "denied",
        detail: { requestId, reason: "not_originating_operator" },
      });
      return;
    }

    if (result === "orphan") {
      this.logger.info({ chatId, requestId }, "orphan card action — patching as expired");
      if (messageId) {
        this.presenter.expirePermissionCard(messageId, ORPHAN_CARD_REASON).catch((err: unknown) => {
          this.logger.warn({ err }, "expirePermissionCard failed");
        });
      }
      return;
    }

    this.audit.record({
      action: "tool.authorized",
      chatId,
      operatorOpenId: clicker.openId,
      outcome: "allowed",
      detail: { optionId },
    });

    if (messageId && optionName && toolKind && toolTitle) {
      this.presenter
        .updatePermissionCard(messageId, toolKind, toolTitle, optionName)
        .catch((err: unknown) => {
          this.logger.warn({ err }, "updatePermissionCard failed");
        });
    }
  }

  // ----- Lifecycle helpers ------------------------------------------------

  private evictIdle(): void {
    if (this.idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const [chatId, runtime] of this.chats) {
      if (runtime.processing) continue;
      if (now - runtime.lastActivity <= this.idleTimeoutMs) continue;
      this.logger.info({ chatId }, "evicting idle chat");
      runtime.shutdown();
      this.chats.delete(chatId);
      this.unregisterTools(chatId);
    }
  }

  /** Best-effort teardown of a chat's Lark tool context (no-op if disabled). */
  private unregisterTools(chatId: string): void {
    if (!this.toolServer) return;
    void this.toolServer.unregister(chatId).catch((err: unknown) => {
      this.logger.debug({ err, chatId }, "tool context unregister failed");
    });
  }

  private evictOldest(): void {
    let oldest: { chatId: string; lastActivity: number } | null = null;
    for (const [chatId, runtime] of this.chats) {
      if (runtime.processing) continue;
      if (!oldest || runtime.lastActivity < oldest.lastActivity) {
        oldest = { chatId, lastActivity: runtime.lastActivity };
      }
    }
    if (!oldest) return;
    this.logger.info({ chatId: oldest.chatId }, "max concurrent chats reached — evicting oldest");
    const runtime = this.chats.get(oldest.chatId);
    runtime?.shutdown();
    this.chats.delete(oldest.chatId);
    this.unregisterTools(oldest.chatId);
  }
}
