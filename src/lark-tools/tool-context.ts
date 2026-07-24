import crypto from "node:crypto";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";
import type { CardActionClicker, CardActionResult } from "../acp/lark-acp-client.js";

/** Outcome of a blocking `ask_choice`. */
export interface AskChoiceResult {
  readonly optionId: string;
  readonly label: string;
}

/** A downloaded message attachment. */
export interface DownloadedResource {
  readonly bytes: Buffer;
  readonly mimeType: string;
}

interface PendingAsk {
  readonly askId: string;
  readonly resolve: (result: AskChoiceResult) => void;
  readonly reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  cardMessageId: string | null;
  /**
   * `open_id` of the user whose prompt triggered the question — only this
   * operator (or a privileged user) may answer, reusing the permission-card
   * operator-binding rule (plan §4.1).
   */
  readonly operatorOpenId: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
}

/** Thrown when a blocking interactive tool is not answered in time. */
export class AskTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskTimeoutError";
  }
}

const ASK_EXPIRED_REASON = "No response within the time limit — this question has expired";
const ASK_DISPOSED_REASON = "The session has ended — this question has expired";

export interface ToolContextOptions {
  readonly chatId: string;
  readonly http: LarkHttpClient;
  readonly logger: LarkLogger;
  /** Auto-fail a blocking ask after this many ms (0 = wait forever). */
  readonly askTimeoutMs: number;
}

/**
 * Per-chat execution context an MCP tool runs against. Owns the interactive
 * ask-choice promise-bridge (structurally identical to the permission-card
 * bridge in {@link LarkAcpClient}) and read-only Lark operations.
 *
 * One instance per {@link ChatRuntime}; created on register, torn down via
 * {@link dispose} on shutdown/evict. Credentials never leave the bridge —
 * every Lark call goes through the shared {@link LarkHttpClient}.
 */
export class ToolContext {
  readonly chatId: string;
  private readonly http: LarkHttpClient;
  private readonly logger: LarkLogger;
  private readonly askTimeoutMs: number;
  private readonly pendingAsks = new Map<string, PendingAsk>();
  /**
   * `open_id` of the operator whose prompt is currently being processed —
   * set by the bridge at enqueue time and used to bind interactive cards.
   */
  private currentOperator = "";

  constructor(opts: ToolContextOptions) {
    this.chatId = opts.chatId;
    this.http = opts.http;
    this.logger = opts.logger.child({ name: "tool-ctx", chatId: opts.chatId });
    this.askTimeoutMs = opts.askTimeoutMs;
  }

  /** Record the operator of the in-flight prompt (binds subsequent asks). */
  setOperator(openId: string): void {
    this.currentOperator = openId;
  }

  /**
   * Send a choice card to the chat and block until the bound operator taps an
   * option (or the ask times out).
   *
   * @throws {AskTimeoutError} when no answer arrives within `askTimeoutMs`.
   * @throws when the card cannot be sent.
   */
  async askChoice(question: string, labels: readonly string[]): Promise<AskChoiceResult> {
    const options = labels.map((label, i) => ({ id: `opt${String(i)}`, label }));
    const askId = crypto.randomUUID();
    const operatorOpenId = this.currentOperator;

    const cardMessageId = await this.http.sendCardToChat(
      this.chatId,
      buildChoiceCard(question, askId, options, this.chatId),
    );

    return new Promise<AskChoiceResult>((resolve, reject) => {
      const timer =
        this.askTimeoutMs > 0
          ? setTimeout(() => {
              this.expire(askId, ASK_EXPIRED_REASON);
            }, this.askTimeoutMs)
          : null;
      if (timer?.unref) timer.unref();

      this.pendingAsks.set(askId, {
        askId,
        resolve,
        reject,
        timer,
        cardMessageId,
        operatorOpenId,
        options,
      });
    });
  }

  /**
   * Route a choice-card click. Mirrors {@link LarkAcpClient.handleCardAction}:
   * only the originating operator (or a privileged user) may answer; anyone
   * else is `forbidden` and the card stays pending.
   */
  resolveAsk(askId: string, optionId: string, clicker: CardActionClicker): CardActionResult {
    const pending = this.pendingAsks.get(askId);
    if (!pending) return "orphan";

    if (clicker.openId !== pending.operatorOpenId && !clicker.privileged) {
      return "forbidden";
    }

    const option = pending.options.find((o) => o.id === optionId);
    if (!option) return "orphan";

    this.dispose1(pending);
    if (pending.cardMessageId) {
      void this.http
        .patchCard(pending.cardMessageId, buildChoiceResolvedCard(option.label))
        .catch((err: unknown) => {
          this.logger.debug({ err }, "patch resolved choice card failed");
        });
    }
    pending.resolve({ optionId: option.id, label: option.label });
    return "resolved";
  }

  /**
   * Download a user-sent attachment referenced by `message_id` + `file_key`.
   *
   * @throws when the download fails.
   */
  async downloadMessageFile(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
  ): Promise<DownloadedResource> {
    return this.http.downloadMessageResource(messageId, fileKey, type);
  }

  /** Fail every pending ask and clear timers — called on shutdown/evict. */
  dispose(): void {
    for (const pending of this.pendingAsks.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.cardMessageId) {
        void this.http
          .patchCard(pending.cardMessageId, buildChoiceResolvedCard(ASK_DISPOSED_REASON))
          .catch(() => undefined);
      }
      pending.reject(new AskTimeoutError(ASK_DISPOSED_REASON));
    }
    this.pendingAsks.clear();
  }

  private expire(askId: string, reason: string): void {
    const pending = this.pendingAsks.get(askId);
    if (!pending) return;
    this.dispose1(pending);
    if (pending.cardMessageId) {
      void this.http
        .patchCard(pending.cardMessageId, buildChoiceResolvedCard(reason))
        .catch(() => undefined);
    }
    pending.reject(new AskTimeoutError(reason));
  }

  private dispose1(pending: PendingAsk): void {
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingAsks.delete(pending.askId);
  }
}

// ---- card builders (local v2 callback cards — no presenter coupling) ----

const CARD_SCHEMA_V2 = "2.0";
const CARD_CONFIG_V2 = { width_mode: "fill", update_multi: true } as const;

function buildChoiceCard(
  question: string,
  askId: string,
  options: readonly { readonly id: string; readonly label: string }[],
  chatId: string,
): object {
  const elements: object[] = [{ tag: "markdown", content: question }];
  for (const opt of options) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: opt.label },
      type: "default",
      behaviors: [{ type: "callback", value: { ask: askId, opt: opt.id, c: chatId } }],
    });
  }
  return {
    schema: CARD_SCHEMA_V2,
    config: CARD_CONFIG_V2,
    header: {
      title: { tag: "plain_text" as const, content: "Agent needs your choice" },
      template: "turquoise",
    },
    body: { elements },
  };
}

function buildChoiceResolvedCard(text: string): object {
  return {
    schema: CARD_SCHEMA_V2,
    config: CARD_CONFIG_V2,
    header: { title: { tag: "plain_text" as const, content: "Answered" }, template: "grey" },
    body: { elements: [{ tag: "markdown", content: text }] },
  };
}
