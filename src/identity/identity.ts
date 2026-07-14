/**
 * `lark-cli` identity policy + prompt-context injection (architecture plan
 * Phase-1 item #2, mitigating §4.2).
 *
 * Two orthogonal concerns, both about *who the assistant is acting as*:
 *
 * 1. **Identity policy** — `bot-only` (default) runs Lark skills as the
 *    app/tenant token; `user-default` signals that personal-resource access
 *    should be performed as the requesting user. The bridge exposes this to
 *    the agent subprocess via a documented set of `LARK_ACP_*` environment
 *    variables and a managed, `dataDir`-local config directory a Lark-aware
 *    tool (e.g. `lark-cli`) can use to cache tokens.
 *
 * 2. **Prompt-context injection** — a structured block prepended to the
 *    agent's prompt describing the chat and sender, so the agent can chain
 *    into Lark skills with the right chat/user ids.
 *
 * ## Warm-process constraint
 *
 * The agent subprocess is kept warm **per chat** and shared across messages
 * from (potentially) different senders in a group. Environment variables are
 * therefore only injected once, at spawn, and carry *chat-level* facts
 * (identity policy, chat id, credentials location). Per-message *sender*
 * identity is carried in the prompt context instead.
 *
 * ## Phase-1 limitation
 *
 * `user-default` currently *signals* the intended acting identity to the
 * agent and its tools; genuine per-user `user_access_token` acquisition is a
 * Phase-2 concern (plan §4.2 / §9). Until then, keep the bot's tenant scopes
 * minimal and gate write-capable skills behind permission cards.
 */

import fs from "node:fs";
import type { LarkLogger } from "../logger/logger.js";

export const IDENTITY_POLICIES = ["bot-only", "user-default"] as const;

/** How Lark skills should authenticate — see the module doc. */
export type IdentityPolicy = (typeof IDENTITY_POLICIES)[number];

export function isIdentityPolicy(value: string): value is IdentityPolicy {
  return (IDENTITY_POLICIES as readonly string[]).includes(value);
}

/** Per-message facts used to build the prompt-context block. */
export interface PromptContext {
  readonly chatType: "p2p" | "group";
  readonly chatId: string;
  readonly chatName?: string;
  readonly userId: string;
  readonly userName: string;
}

export interface IdentityOptions {
  readonly policy: IdentityPolicy;
  /**
   * `dataDir`-local directory a Lark-aware tool can use for its own config /
   * token cache. Created lazily on first {@link Identity.agentEnv} call.
   */
  readonly configDir: string;
  /**
   * Inject the bot app credentials (`LARK_ACP_APP_ID` / `LARK_ACP_APP_SECRET`)
   * into the agent subprocess env. Needed for `bot-only` `lark-cli` to
   * authenticate, but widens secret exposure to every tool the agent runs —
   * hence **off by default**.
   */
  readonly injectCredentials: boolean;
  /** Prepend a structured context block to prompts. Default `true`. */
  readonly injectPromptContext: boolean;
  readonly appId: string;
  readonly appSecret: string;
  readonly domain?: string;
  readonly logger: LarkLogger;
}

/** Environment variable names the bridge injects — the documented contract. */
export const IDENTITY_ENV = {
  policy: "LARK_ACP_IDENTITY_POLICY",
  chatId: "LARK_ACP_CHAT_ID",
  configDir: "LARK_ACP_CONFIG_DIR",
  domain: "LARK_ACP_DOMAIN",
  appId: "LARK_ACP_APP_ID",
  appSecret: "LARK_ACP_APP_SECRET",
} as const;

export class Identity {
  private readonly opts: IdentityOptions;
  private readonly logger: LarkLogger;
  private configDirEnsured = false;

  constructor(opts: IdentityOptions) {
    this.opts = opts;
    this.logger = opts.logger.child({ name: "identity" });
  }

  get policy(): IdentityPolicy {
    return this.opts.policy;
  }

  /**
   * Environment variables to inject into the agent subprocess spawned for
   * `chatId`. Idempotently ensures the shared config directory exists.
   *
   * @throws when the config directory cannot be created.
   */
  agentEnv(chatId: string): Record<string, string> {
    this.ensureConfigDir();

    const env: Record<string, string> = {
      [IDENTITY_ENV.policy]: this.opts.policy,
      [IDENTITY_ENV.chatId]: chatId,
      [IDENTITY_ENV.configDir]: this.opts.configDir,
    };
    if (this.opts.domain !== undefined) env[IDENTITY_ENV.domain] = this.opts.domain;
    if (this.opts.injectCredentials) {
      env[IDENTITY_ENV.appId] = this.opts.appId;
      env[IDENTITY_ENV.appSecret] = this.opts.appSecret;
    }
    return env;
  }

  /**
   * The per-message prompt-context block, or `null` when context injection
   * is disabled.
   */
  promptContext(ctx: PromptContext): string | null {
    if (!this.opts.injectPromptContext) return null;

    const lines: string[] =
      ctx.chatType === "group"
        ? [
            `[上下文: 群聊 "${ctx.chatName ?? ""}" (${ctx.chatId}) 中用户 ${ctx.userName} (${ctx.userId}) 的消息]`,
          ]
        : [`[上下文: 用户 ${ctx.userName} (${ctx.userId}) 的私聊消息]`];

    lines.push(
      this.opts.policy === "user-default"
        ? `[身份策略: user-default — 访问该用户的个人 Lark 资源时请以其身份 (open_id: ${ctx.userId}) 操作，仅在必要时回退到机器人身份]`
        : `[身份策略: bot-only — Lark 操作以机器人（应用）身份执行]`,
    );
    return lines.join("\n");
  }

  private ensureConfigDir(): void {
    if (this.configDirEnsured) return;
    fs.mkdirSync(this.opts.configDir, { recursive: true });
    this.configDirEnsured = true;
    this.logger.debug({ configDir: this.opts.configDir, policy: this.opts.policy }, "identity ready");
  }
}
