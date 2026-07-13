import * as Lark from "@larksuiteoapi/node-sdk";
import { createPinoLogger, type LarkLogger } from "../logger/logger.js";
import { LarkHttpClient } from "../lark/lark-http.js";
import { LarkWsConnection } from "../lark/lark-ws.js";
import type { LarkDomainInput } from "../lark/domain.js";
import { LarkCardPresenter } from "../presenter/lark-presenter.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import {
  interpretLarkMessage,
  type InterpretedMessage,
  type LarkCommand,
} from "../interpreter/lark-interpreter.js";
import { ChatRuntime, type PendingMessage } from "./chat-runtime.js";
import type { PermissionMode } from "../acp/lark-acp-client.js";
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

const SENDER_TYPE_USER = "user";
const CHAT_TYPE_GROUP = "group";

const COMMAND_NOTICES: Readonly<Record<LarkCommand["kind"], NoticeCardSpec>> = {
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
      const mentioned = message.mentions?.some((m) => m.id.open_id === botOpenId);
      if (!mentioned) {
        this.logger.debug({ chatId }, "skipping group message — bot not mentioned");
        return;
      }
    }

    const interpreted: InterpretedMessage = interpretLarkMessage(event, { botOpenId });
    switch (interpreted.kind) {
      case "empty":
        return;
      case "command":
        await this.handleCommand(interpreted.command, chatId, messageId);
        return;
      case "prompt":
        await this.enqueueWithContext(event, chatId, userId, messageId, interpreted.blocks);
        return;
      default:
        return assertNever(interpreted);
    }
  }

  private async handleCommand(
    command: LarkCommand,
    chatId: string,
    messageId: string,
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
      default:
        return assertNever(command);
    }
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

      const context = isGroup
        ? `[上下文: 群聊 "${chatName}" (${chatId}) 中用户 ${userName} (${userId}) 的消息]`
        : `[上下文: 用户 ${userName} (${userId}) 的私聊消息]`;

      prompt.unshift({ type: "text", text: context });
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
      agentEnv: this.agentOpts.env,
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

  private handleCardAction(event: Lark.CardActionEvent): void {
    const value = event.action.value as CardActionPayload | undefined;
    if (!value?.c) return;

    if (value.cancel === true) {
      this.handleCancelButton(value.c);
      return;
    }

    if (!value.r || !value.o) return;
    this.handlePermissionCardAction(event, value.c, value.r, value.o, value.n, value.k, value.t);
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
  ): void {
    const runtime = this.chats.get(chatId);
    const handled = runtime?.handleCardAction(requestId, optionId) ?? false;
    const messageId = event.messageId;

    if (!handled) {
      this.logger.info({ chatId, requestId }, "orphan card action — patching as expired");
      if (messageId) {
        this.presenter.expirePermissionCard(messageId, ORPHAN_CARD_REASON).catch((err: unknown) => {
          this.logger.warn({ err }, "expirePermissionCard failed");
        });
      }
      return;
    }

    this.logger.info({ chatId, optionId }, "card action resolved");

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
