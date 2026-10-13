import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type {
  AgentStatus,
  LarkPresenter,
  TimelineEntry,
  ToolStatus,
  UnifiedCardState,
} from "../presenter/presenter.js";

const TYPING_INTERVAL_MS = 5_000;
// Coalescing window between card patches. Each patch re-sends the whole
// card JSON and counts against Lark's OpenAPI rate limits, so anything
// much below ~300ms burns quota with no visible benefit.
const CARD_FLUSH_DEBOUNCE_MS = 300;

// Lark rejects cards whose JSON exceeds ~30KB, and a failed patch means the
// user stops seeing updates entirely — so display-only content (diffs,
// thoughts, tool inputs) is capped rather than allowed to grow unboundedly.
// Answer text is never truncated; if the final card can't be delivered it
// falls back to a plain-text reply instead (see `finalize`).
const MAX_DIFF_LINES = 50;
const MAX_THOUGHT_CHARS = 4_000;
const MAX_TOOL_DETAIL_CHARS = 500;

const TRUNCATION_NOTICE = "… (content too long, truncated)";

const PERMISSION_TIMEOUT_REASON = "No response within the time limit — automatically cancelled";
const PERMISSION_SHUTDOWN_REASON = "The session has ended — this approval request has expired";

/**
 * Thrown when the agent asks to read / write a path outside its working
 * directory. The bridge runs with its own privileges on behalf of anyone
 * who can message the bot, so agent filesystem access is confined to
 * `agentCwd`.
 */
export class AgentFsAccessError extends Error {
  readonly requestedPath: string;
  readonly agentCwd: string;

  constructor(requestedPath: string, agentCwd: string) {
    super(`path escapes agent working directory: ${requestedPath}`);
    this.name = "AgentFsAccessError";
    this.requestedPath = requestedPath;
    this.agentCwd = agentCwd;
  }
}

interface PendingPermission {
  requestId: string;
  resolve: (value: acp.RequestPermissionResponse) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Card message id, set once `sendInterruptCard` resolves. */
  cardMessageId: string | null;
  /**
   * Lark `open_id` of the user whose prompt triggered this permission
   * request. Only this operator (or a privileged user) may resolve the
   * card — see {@link LarkAcpClient.handleCardAction}.
   */
  operatorOpenId: string;
}

/**
 * Outcome of routing a permission-card button click.
 *
 * - `resolved` — the click resolved the pending request.
 * - `orphan` — no pending request matched (expired / already handled).
 * - `forbidden` — the clicker isn't the originating operator (or privileged),
 *   so the request is left pending for the rightful operator.
 */
export type CardActionResult = "resolved" | "orphan" | "forbidden";

/** Identity of a user clicking a permission-card button. */
export interface CardActionClicker {
  readonly openId: string;
  /** `true` when the clicker is an owner/admin who may resolve any card. */
  readonly privileged: boolean;
}

export interface LarkAcpClientCallbacks {
  /** Called whenever the agent emits activity — used to refresh "typing" indicator. */
  onTyping: () => Promise<void>;
}

/**
 * Strategy for handling agent-side permission requests.
 *
 * - `alwaysAsk` (default) — forward every request to the user as a Lark card
 *   and block the agent until they pick an option.
 * - `alwaysAllow` — auto-pick the agent's first `allow_*` option without
 *   bothering the user. Falls back to `cancelled` if no allow option exists.
 * - `alwaysDeny` — auto-pick the agent's first `reject_*` option, falling
 *   back to `cancelled` (which the agent treats as a denial).
 */
export type PermissionMode = "alwaysAllow" | "alwaysDeny" | "alwaysAsk";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "alwaysAsk",
  "alwaysAllow",
  "alwaysDeny",
] as const;

export interface LarkAcpClientOptions {
  presenter: LarkPresenter;
  logger: LarkLogger;
  /** Agent working directory — `fs/read_text_file` / `fs/write_text_file` are confined to it. */
  agentCwd: string;
  /** Include `agent_thought_chunk` updates in the unified card. */
  showThoughts: boolean;
  /** Include `tool_call` / `tool_call_update` events in the unified card. */
  showTools: boolean;
  /**
   * Render the "Stop current task" button at the bottom of the running card.
   * When `false`, the only way to cancel is via a chat command.
   */
  showCancelButton: boolean;
  callbacks: LarkAcpClientCallbacks;
  /** Resolve a pending permission as `cancelled` after this many ms (0 = never). */
  permissionTimeoutMs: number;
  /** Permission gate strategy — see {@link PermissionMode}. */
  permissionMode: PermissionMode;
}

/**
 * `acp.Client` implementation for one Lark chat. Builds a unified
 * timeline (text / thought / tool entries) per prompt and patches a
 * single Lark card as the agent works.
 *
 * One instance per chat — it holds per-prompt state (current message id,
 * timeline entries, unified card id, pending permissions).
 */
export class LarkAcpClient implements acp.Client {
  private readonly presenter: LarkPresenter;
  private readonly logger: LarkLogger;
  private readonly agentCwd: string;
  private readonly showThoughts: boolean;
  private readonly showTools: boolean;
  private readonly showCancelButton: boolean;
  private readonly permissionTimeoutMs: number;
  private readonly permissionMode: PermissionMode;
  private callbacks: LarkAcpClientCallbacks;

  private timeline: TimelineEntry[] = [];
  private status: AgentStatus = "thinking";
  private lastTypingAt = 0;
  private currentMessageId = "";
  private currentChatId = "";
  private currentOperatorOpenId = "";

  private readonly pendingPermissions = new Map<string, PendingPermission>();

  /** Tool-call id → index into `timeline` for fast updates. */
  private readonly toolIndex = new Map<string, number>();

  private cardId: string | null = null;
  private cardCreating: Promise<string | null> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(opts: LarkAcpClientOptions) {
    this.presenter = opts.presenter;
    this.logger = opts.logger.child({ name: "acp-client" });
    this.agentCwd = path.resolve(opts.agentCwd);
    this.showThoughts = opts.showThoughts;
    this.showTools = opts.showTools;
    this.showCancelButton = opts.showCancelButton;
    this.permissionTimeoutMs = opts.permissionTimeoutMs;
    this.permissionMode = opts.permissionMode;
    this.callbacks = opts.callbacks;
  }

  updateCallbacks(cbs: LarkAcpClientCallbacks): void {
    this.callbacks = cbs;
  }

  /** Bind the current Lark message context so cards reply to the right message. */
  setContext(messageId: string, chatId: string, operatorOpenId = ""): void {
    this.currentMessageId = messageId;
    this.currentChatId = chatId;
    this.currentOperatorOpenId = operatorOpenId;
  }

  // ----- Permission flow --------------------------------------------------

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    if (this.permissionMode !== "alwaysAsk") {
      return this.autoResolvePermission(params, this.permissionMode);
    }

    if (!this.currentMessageId) {
      this.logger.warn(
        { tool: params.toolCall.title ?? "unknown" },
        "no message context — cancelling permission request",
      );
      return { outcome: { outcome: "cancelled" } };
    }

    const requestId = crypto.randomUUID();

    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const pending: PendingPermission = {
        requestId,
        resolve,
        timer: null,
        cardMessageId: null,
        operatorOpenId: this.currentOperatorOpenId,
      };
      this.pendingPermissions.set(requestId, pending);

      if (this.permissionTimeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.expirePendingPermission(requestId, PERMISSION_TIMEOUT_REASON);
        }, this.permissionTimeoutMs);
      }

      this.presenter
        .sendInterruptCard(this.currentMessageId, params, requestId, this.currentChatId)
        .then((cardMessageId) => {
          const stillPending = this.pendingPermissions.get(requestId);
          if (stillPending) stillPending.cardMessageId = cardMessageId;
        })
        .catch((err: unknown) => {
          this.logger.warn({ err, requestId }, "sendInterruptCard failed");
          this.disposePending(requestId);
          resolve({ outcome: { outcome: "cancelled" } });
        });
    });
  }

  private autoResolvePermission(
    params: acp.RequestPermissionRequest,
    mode: "alwaysAllow" | "alwaysDeny",
  ): acp.RequestPermissionResponse {
    const wantAllow = mode === "alwaysAllow";
    const prefix = wantAllow ? "allow_" : "reject_";
    const match = params.options.find((o) => o.kind.startsWith(prefix));
    const tool = params.toolCall.title ?? "unknown";

    if (!match) {
      this.logger.warn(
        { mode, tool, kinds: params.options.map((o) => o.kind) },
        "permissionMode auto-resolve found no matching option, falling back to cancelled",
      );
      return { outcome: { outcome: "cancelled" } };
    }

    this.logger.info(
      { mode, tool, optionId: match.optionId, kind: match.kind },
      "permissionMode auto-resolved",
    );
    return { outcome: { outcome: "selected", optionId: match.optionId } };
  }

  /**
   * Resolve a pending permission from a card-button click.
   *
   * The click is only honoured when it comes from the operator who
   * triggered the request, or from a privileged (owner/admin) user. Any
   * other clicker is rejected and the request stays pending — closing the
   * §4.1 hole where any group member could approve another user's tool call.
   */
  handleCardAction(
    requestId: string,
    optionId: string,
    clicker: CardActionClicker,
  ): CardActionResult {
    const pp = this.pendingPermissions.get(requestId);
    if (!pp) return "orphan";

    // An empty recorded operator means the request predates operator
    // tracking (or context was never bound); fall back to open behaviour
    // rather than deadlocking the card.
    const boundOperator = pp.operatorOpenId;
    const isOperator = boundOperator === "" || clicker.openId === boundOperator;
    if (!isOperator && !clicker.privileged) {
      this.logger.warn(
        { requestId, clicker: clicker.openId, operator: boundOperator },
        "card action rejected — clicker is not the originating operator",
      );
      return "forbidden";
    }

    this.disposePending(requestId);
    pp.resolve({ outcome: { outcome: "selected", optionId } });
    return "resolved";
  }

  cancelPendingPermission(): void {
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.expirePendingPermission(requestId, PERMISSION_SHUTDOWN_REASON);
    }
  }

  private expirePendingPermission(requestId: string, reason: string): void {
    const pp = this.pendingPermissions.get(requestId);
    if (!pp) return;
    this.disposePending(requestId);
    pp.resolve({ outcome: { outcome: "cancelled" } });

    const cardId = pp.cardMessageId;
    if (cardId) {
      this.presenter.expirePermissionCard(cardId, reason).catch((err: unknown) => {
        this.logger.debug({ err, cardId }, "expirePermissionCard rejected");
      });
    }
  }

  private disposePending(requestId: string): void {
    const pp = this.pendingPermissions.get(requestId);
    if (!pp) return;
    if (pp.timer) clearTimeout(pp.timer);
    this.pendingPermissions.delete(requestId);
  }

  // ----- Session updates → timeline --------------------------------------

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") {
          this.appendText("text", u.content.text);
          this.status = "responding";
          this.scheduleFlush();
        }
        await this.maybeSendTyping();
        return;

      case "agent_thought_chunk":
        if (u.content.type === "text" && this.showThoughts) {
          this.appendText("thought", u.content.text);
          if (this.status !== "responding") this.status = "thinking";
          this.scheduleFlush();
        }
        await this.maybeSendTyping();
        return;

      case "tool_call": {
        if (!this.showTools) return;
        const toolCallId = u.toolCallId;
        if (!toolCallId) return;
        const rawInput = u.rawInput;
        const detail =
          typeof rawInput === "string" ? truncateChars(rawInput, MAX_TOOL_DETAIL_CHARS) : undefined;
        this.upsertTool(toolCallId, u.title, u.kind ?? "tool", u.status ?? "in_progress", detail);
        this.status = "calling_tool";
        this.scheduleFlush();
        await this.maybeSendTyping();
        return;
      }

      case "tool_call_update": {
        if (!this.showTools) return;
        const toolCallId = u.toolCallId;
        if (!toolCallId) return;
        if (u.status !== "completed" && u.status !== "failed") return;

        if (u.content) {
          for (const c of u.content) {
            if (c.type !== "diff") continue;
            const lines: string[] = [`--- ${c.path}`];
            c.oldText?.split("\n").forEach((l) => lines.push(`- ${l}`));
            c.newText.split("\n").forEach((l) => lines.push(`+ ${l}`));
            this.appendText(
              "text",
              "\n```diff\n" + truncateLines(lines, MAX_DIFF_LINES) + "\n```\n",
            );
          }
        }
        this.upsertTool(toolCallId, u.title ?? "unknown", u.kind ?? "tool", u.status);
        this.scheduleFlush();
        return;
      }
    }
  }

  /**
   * @throws {AgentFsAccessError} when `params.path` resolves outside the agent cwd.
   */
  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const resolved = this.resolveAgentPath(params.path);
    this.logger.debug({ path: resolved }, "agent fs read");
    const content = await fs.promises.readFile(resolved, "utf-8");
    return { content: sliceFileContent(content, params.line, params.limit) };
  }

  /**
   * @throws {AgentFsAccessError} when `params.path` resolves outside the agent cwd.
   */
  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const resolved = this.resolveAgentPath(params.path);
    this.logger.info({ path: resolved }, "agent fs write");
    await fs.promises.writeFile(resolved, params.content, "utf-8");
    return {};
  }

  /**
   * Resolve an agent-supplied path against the agent cwd and confine it there.
   *
   * @throws {AgentFsAccessError} when the resolved path escapes the agent cwd.
   */
  private resolveAgentPath(requested: string): string {
    const resolved = path.resolve(this.agentCwd, requested);
    const relative = path.relative(this.agentCwd, resolved);
    // `..` prefix = walks out of cwd; absolute relative = different drive (Windows).
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      this.logger.warn(
        { requested, agentCwd: this.agentCwd },
        "agent fs access outside cwd denied",
      );
      throw new AgentFsAccessError(requested, this.agentCwd);
    }
    return resolved;
  }

  /**
   * Finalise the unified card with the given terminal status, then reset
   * per-prompt state so the next prompt starts clean.
   *
   * If the final card can't be delivered (e.g. the timeline pushed the card
   * JSON past Lark's size limit and every patch fails), the answer text is
   * sent as plain reply messages instead so content is never lost.
   */
  async finalize(status: AgentStatus): Promise<void> {
    this.status = status;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Wait for any in-flight flush so we don't race the final patch.
    while (this.flushing) await new Promise<void>((r) => setTimeout(r, 10));
    try {
      await this.renderCard({ cancellable: false });
      // Card was never created (every send failed) — the user has seen nothing.
      if (!this.cardId && this.timeline.length > 0) await this.replyFinalTextFallback();
    } catch (err) {
      this.logger.warn({ err }, "final card render failed — falling back to text reply");
      await this.replyFinalTextFallback();
    } finally {
      this.timeline = [];
      this.toolIndex.clear();
      this.cardId = null;
      this.cardCreating = null;
      this.lastTypingAt = 0;
      this.status = "thinking";
    }
  }

  /** Last-resort delivery path: reply the accumulated answer text as plain messages. */
  private async replyFinalTextFallback(): Promise<void> {
    if (!this.currentMessageId) return;
    const answer = this.timeline
      .filter((entry) => entry.kind === "text")
      .map((entry) => entry.text)
      .join("")
      .trim();
    if (!answer) return;
    await this.presenter.replyText(this.currentMessageId, answer).catch((err: unknown) => {
      this.logger.error({ err }, "final text fallback failed — answer lost");
    });
  }

  // ----- Timeline mutators ------------------------------------------------

  private appendText(kind: "text" | "thought", text: string): void {
    if (!text) return;
    const last = this.timeline.at(-1);
    if (last?.kind === kind) {
      // Thought entries are display-only — stop growing them past the cap
      // so a chatty reasoning stream can't blow the card size budget.
      // Answer text is never truncated (see `finalize` fallback instead).
      if (kind === "thought" && last.text.endsWith(TRUNCATION_NOTICE)) return;
      last.text += text;
      if (kind === "thought" && last.text.length > MAX_THOUGHT_CHARS) {
        last.text = last.text.slice(0, MAX_THOUGHT_CHARS) + TRUNCATION_NOTICE;
      }
      return;
    }
    this.timeline.push({
      kind,
      text: kind === "thought" ? truncateChars(text, MAX_THOUGHT_CHARS) : text,
    });
  }

  private upsertTool(
    toolCallId: string,
    title: string,
    toolKind: string,
    status: ToolStatus,
    detail?: string,
  ): void {
    const idx = this.toolIndex.get(toolCallId);
    if (idx !== undefined) {
      const existing = this.timeline[idx];
      if (existing?.kind === "tool") {
        if (title !== "unknown") existing.title = title;
        existing.toolKind = toolKind;
        existing.status = status;
        if (detail !== undefined) existing.detail = detail;
      }
      return;
    }
    this.toolIndex.set(toolCallId, this.timeline.length);
    this.timeline.push({ kind: "tool", toolCallId, title, toolKind, status, detail });
  }

  // ----- Card flush -------------------------------------------------------

  private scheduleFlush(): void {
    if (!this.currentMessageId) return;
    // Coalesce instead of resetting the timer: with a reset-style debounce a
    // fast stream (chunks arriving faster than the window) would starve the
    // card of updates entirely until the stream paused.
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.renderCard({ cancellable: true }).catch((err: unknown) => {
        this.logger.warn({ err }, "card flush failed");
      });
    }, CARD_FLUSH_DEBOUNCE_MS);
  }

  private async renderCard(opts: { cancellable: boolean }): Promise<void> {
    if (!this.currentMessageId && !this.cardId) return;
    this.flushing = true;
    try {
      const state: UnifiedCardState = {
        status: this.status,
        entries: this.timeline,
        cancellable: opts.cancellable && this.showCancelButton,
        chatId: this.currentChatId,
      };

      if (this.cardId) {
        await this.presenter.updateUnifiedCard(this.cardId, state);
        return;
      }
      if (this.cardCreating) {
        const id = await this.cardCreating;
        if (id) {
          this.cardId = id;
          await this.presenter.updateUnifiedCard(id, state);
        }
        return;
      }
      const promise = this.presenter.sendUnifiedCard(this.currentMessageId, state);
      this.cardCreating = promise;
      try {
        const id = await promise;
        if (id) this.cardId = id;
      } finally {
        this.cardCreating = null;
      }
    } finally {
      this.flushing = false;
    }
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    await this.callbacks.onTyping().catch((err: unknown) => {
      this.logger.debug({ err }, "onTyping rejected");
    });
  }
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_NOTICE;
}

function truncateLines(lines: readonly string[], maxLines: number): string {
  if (lines.length <= maxLines) return lines.join("\n");
  const omitted = lines.length - maxLines;
  return [...lines.slice(0, maxLines), `... (${omitted} more lines omitted)`].join("\n");
}

/** Apply ACP's optional 1-based `line` offset and `limit` (max lines) to file content. */
function sliceFileContent(
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined,
): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = line != null && line > 1 ? line - 1 : 0;
  const end = limit != null ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
}
