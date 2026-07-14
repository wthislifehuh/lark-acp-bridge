import * as Lark from "@larksuiteoapi/node-sdk";
import { createPinoLogger, type LarkLogger } from "../logger/logger.js";
import { LarkHttpClient } from "../lark/lark-http.js";
import { LarkWsConnection, type LarkWsKeepaliveOptions } from "../lark/lark-ws.js";
import type { LarkDomainInput } from "../lark/domain.js";
import { LarkCardPresenter } from "../presenter/lark-presenter.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import {
  interpretLarkMessage,
  type AccessCommandTarget,
  type InterpretedMessage,
  type LarkCommand,
} from "../interpreter/lark-interpreter.js";
import { ChatRuntime, type PendingMessage } from "./chat-runtime.js";
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
const DEFAULT_PERMISSION_MODE: PermissionMode = "alwaysAsk";
const IDLE_CLEANUP_INTERVAL_MS = 2 * 60_000;

const ORPHAN_CARD_REASON = "会话已结束，本次确认已失效";

const ACCESS_DISABLED_NOTICE: NoticeCardSpec = {
  title: "访问控制未启用",
  body: "当前实例未启用访问控制，所有可见用户均可使用机器人。",
  template: "grey",
};

const SENDER_TYPE_USER = "user";
const CHAT_TYPE_GROUP = "group";

const COMMAND_NOTICES: Readonly<Record<"cancel" | "new", NoticeCardSpec>> = {
  cancel: {
    title: "已取消",
    body: "已取消当前任务，agent 进程保留以便后续消息继续。",
    template: "grey",
  },
  new: {
    title: "已重置会话",
    body: "下次消息将启动一个全新的 agent 会话。",
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
   * Render the "中断当前任务" button at the bottom of the running unified
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

export interface LarkBridgeOptions {
  lark: LarkBridgeLarkOptions;
  agent: LarkBridgeAgentOptions;
  session?: LarkBridgeSessionOptions;

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

  private readonly chats = new Map<string, ChatRuntime>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ws: LarkWsConnection | null = null;
  private started = false;

  constructor(opts: LarkBridgeOptions) {
    this.lark = opts.lark;
    this.logger = opts.logger ?? createPinoLogger();
    this.sessionStore = opts.sessionStore;

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

      this.cleanupTimer = setInterval(() => {
        this.evictIdle();
      }, IDLE_CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref();

      this.ws = new LarkWsConnection({
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
        ...(this.lark.keepalive !== undefined ? { keepalive: this.lark.keepalive } : {}),
      });
      await this.ws.start();
    } catch (err) {
      if (this.cleanupTimer) clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      this.ws = null;
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
      this.logger.info(
        { audit: true, userId, chatId, allowed: true, role: decision.role },
        decision.ownerClaimed ? "access: ownership claimed" : "access granted",
      );
      return true;
    }

    this.logger.info(
      { audit: true, userId, chatId, allowed: false, reason: decision.reason },
      "access denied — ignoring message",
    );
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
          title: "命令用法",
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
      "**通用命令**",
      "- `/help` · `帮助` — 显示此帮助",
      "- `/status` · `状态` — 查看当前会话与身份状态",
      "- `/cancel` · `/stop` · `取消` — 中断当前任务（保留 agent 进程）",
      "- `/new` · `/restart` — 重置会话，下条消息启动全新 agent 会话",
    ];
    if (privileged) {
      lines.push(
        "",
        "**管理命令（owner / admin）**",
        "- `/config` · `配置` — 查看运行配置",
        "- `/access` — 查看访问控制名单",
        "- `/invite user @用户…` · `/invite admin @用户…` — 加入用户 / 管理员白名单",
        "- `/invite group` — 授权当前群聊",
        "- `/remove user @用户…` · `/remove admin @用户…` · `/remove group` — 移除授权",
        "- `/mention on` · `/mention off` — 群聊是否需要 @机器人",
      );
    }
    lines.push("", "在群聊中使用命令时，请先 @机器人。");
    await this.presenter.replyNoticeCard(messageId, {
      title: "命令帮助",
      body: lines.join("\n"),
      template: "blue",
    });
  }

  private async handleStatus(chatId: string, userId: string, messageId: string): Promise<void> {
    const runtime = this.chats.get(chatId);
    const sessionState = !runtime ? "无活动会话" : runtime.processing ? "运行中" : "空闲（进程保留）";
    const role = this.accessControl ? this.accessControl.roleOf(userId) : "（访问控制未启用）";
    const identity = this.identity ? this.identity.policy : "（未配置）";

    const body = [
      `**你的身份**: ${role}`,
      `**Agent**: ${this.describeAgentLabel()}`,
      `**会话**: ${sessionState}`,
      `**连接**: ${this.describeConnection()}`,
      `**身份策略**: ${identity}`,
      `**权限模式**: ${this.agentOpts.permissionMode}`,
      `**活动会话数**: ${this.chats.size} / ${this.maxConcurrentChats}`,
    ].join("\n");
    await this.presenter.replyNoticeCard(messageId, {
      title: "状态",
      body,
      template: "blue",
    });
  }

  /** WebSocket connection state for `/status`, e.g. `connected` or `reconnecting (2 次)`. */
  private describeConnection(): string {
    const status = this.ws?.getConnectionStatus();
    if (!status) return "未知";
    return status.reconnectAttempts > 0
      ? `${status.state}（重连 ${status.reconnectAttempts} 次）`
      : status.state;
  }

  private async handleConfig(userId: string, messageId: string): Promise<void> {
    const ac = await this.requirePrivilegedAccess(userId, messageId);
    if (!ac) return;

    const onOff = (v: boolean): string => (v ? "开" : "关");
    const s = ac.snapshot();
    const owner = s.effectiveOwner ?? "（未设置）";
    const body = [
      "**展示**",
      `- 思考过程: ${onOff(this.agentOpts.showThoughts)}`,
      `- 工具调用: ${onOff(this.agentOpts.showTools)}`,
      `- 中断按钮: ${onOff(this.agentOpts.showCancelButton)}`,
      "",
      "**权限 / 身份**",
      `- 工具权限模式: ${this.agentOpts.permissionMode}`,
      `- 身份策略: ${this.identity ? this.identity.policy : "（未配置）"}`,
      "",
      "**访问控制**",
      `- Owner: ${owner}`,
      `- Admins: ${s.admins.length}｜Users: ${s.users.length}｜Groups: ${s.groups.length}`,
      `- 群聊需要 @机器人: ${s.requireMentionInGroup ? "是" : "否"}`,
    ].join("\n");
    await this.presenter.replyNoticeCard(messageId, {
      title: "运行配置",
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
    this.logger.info({ audit: true, userId, enabled }, "access: group mention requirement changed");
    await this.presenter.replyNoticeCard(messageId, {
      title: "已更新",
      body: enabled
        ? "群聊中现在需要 @机器人 才会响应。"
        : "群聊中现在无需 @机器人 即可响应（仍受群白名单限制）。",
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
    this.logger.info({ audit: true, userId, kind, target: target.type }, "access: allowlist mutated");
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
          title: added ? "已授权群聊" : "群聊已在白名单",
          body: `chat_id: ${chatId}`,
          template: added ? "green" : "grey",
        };
      }
      case "user":
      case "admin": {
        const added =
          target.type === "user" ? ac.grantUsers(target.openIds) : ac.grantAdmins(target.openIds);
        const label = target.type === "user" ? "用户" : "管理员";
        if (added.length === 0) {
          return { title: "无变化", body: `选中的${label}已在名单中。`, template: "grey" };
        }
        const names = await this.resolveNames(added);
        return { title: `已添加${label}`, body: names.join("\n"), template: "green" };
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
          title: removed ? "已移除群聊授权" : "群聊不在白名单",
          body: `chat_id: ${chatId}`,
          template: removed ? "orange" : "grey",
        };
      }
      case "user":
      case "admin": {
        const removed =
          target.type === "user"
            ? ac.revokeUsers(target.openIds)
            : ac.revokeAdmins(target.openIds);
        const label = target.type === "user" ? "用户" : "管理员";
        if (removed.length === 0) {
          return {
            title: "无变化",
            body: `选中的${label}不在名单中（owner 无法被移除）。`,
            template: "grey",
          };
        }
        const names = await this.resolveNames(removed);
        return { title: `已移除${label}`, body: names.join("\n"), template: "orange" };
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
      : "（未设置 — 首个私聊用户将成为 owner）";
    const admins = s.admins.length > 0 ? (await this.resolveNames(s.admins)).join("\n") : "（无）";
    const users = s.users.length > 0 ? (await this.resolveNames(s.users)).join("\n") : "（无）";
    const groups = s.groups.length > 0 ? s.groups.join("\n") : "（无）";
    const body = [
      `**Owner**: ${ownerLine}`,
      `**Admins**:\n${admins}`,
      `**Users (私聊白名单)**:\n${users}`,
      `**Groups (群白名单)**:\n${groups}`,
      `**群聊需要 @机器人**: ${s.requireMentionInGroup ? "是" : "否"}`,
    ].join("\n\n");
    await this.presenter.replyNoticeCard(messageId, {
      title: "访问控制",
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
      this.logger.info({ audit: true, userId }, "access: privileged command denied");
      await this.presenter.replyNoticeCard(messageId, {
        title: "无权限",
        body: "仅机器人 owner / admin 可执行访问控制命令。",
        template: "red",
      });
      return null;
    }
    return ac;
  }

  /** Resolve `open_id`s to `"Name (open_id)"` display strings. */
  private async resolveNames(openIds: readonly string[]): Promise<string[]> {
    return Promise.all(
      openIds.map(async (id) => `${await this.http.getUserName(id)} (${id})`),
    );
  }

  private async enqueueWithContext(
    event: Lark.RawMessageEvent,
    chatId: string,
    userId: string,
    messageId: string,
    prompt: acp.ContentBlock[],
  ): Promise<void> {
    const runtime = this.acquireRuntime(chatId);

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
      this.logger.error({ err, chatId }, "agent bootstrap failed");
      const summary = `⚠️ Agent 启动失败: ${formatBootstrapError(err)}`;
      await this.presenter.replyText(messageId, summary).catch((sendErr: unknown) => {
        this.logger.warn({ err: sendErr }, "bootstrap error reply failed");
      });
    }
  }

  private acquireRuntime(chatId: string): ChatRuntime {
    const existing = this.chats.get(chatId);
    if (existing) return existing;

    if (this.chats.size >= this.maxConcurrentChats) this.evictOldest();

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
      ? `[上下文: 群聊 "${ctx.chatName ?? ""}" (${ctx.chatId}) 中用户 ${ctx.userName} (${ctx.userId}) 的消息]`
      : `[上下文: 用户 ${ctx.userName} (${ctx.userId}) 的私聊消息]`;
  }

  private handleCardAction(event: Lark.CardActionEvent): void {
    const value = event.action.value as CardActionPayload | undefined;
    if (!value?.c) return;

    if (value.cancel === true) {
      this.handleCancelButton(value.c);
      return;
    }

    if (!value.r || !value.o) return;
    const clicker: CardActionClicker = {
      openId: event.operator.openId,
      privileged: this.accessControl?.isPrivileged(event.operator.openId) ?? false,
    };
    this.handlePermissionCardAction(event, value.c, value.r, value.o, value.n, value.k, value.t, clicker);
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
    const result: CardActionResult = runtime?.handleCardAction(requestId, optionId, clicker) ?? "orphan";
    const messageId = event.messageId;

    if (result === "forbidden") {
      // §4.1: a non-originating, non-privileged user tried to resolve someone
      // else's permission card. Reject silently and leave the card pending so
      // the rightful operator can still act.
      this.logger.warn(
        { audit: true, chatId, requestId, clicker: clicker.openId },
        "permission card click rejected — not the originating operator",
      );
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

    this.logger.info({ audit: true, chatId, optionId, clicker: clicker.openId }, "card action resolved");

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
    }
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
  }
}
