/**
 * Access control for the bridge — the first of the two enforcement points
 * described in the architecture plan (§4.1). Governs **who** may drive the
 * bot (message intake); the card-action enforcement point is bound
 * separately by the bridge using {@link AccessControl.isPrivileged}.
 *
 * Model:
 *
 * - **Private by default.** With no owner and no allowlist entries, only the
 *   owner can talk to the bot; everyone else is silently ignored.
 * - **Owner** — a single `open_id`. Either configured explicitly (config
 *   wins and can never be locked out) or **claimed by the first user to DM
 *   the bot** when unconfigured (self-host bootstrap).
 * - **Admins** — privileged like the owner (bypass allowlists, manage
 *   access) but removable.
 * - **Users** — allowed to use the bot in 1:1 chats.
 * - **Groups** — allowlisted `chat_id`s; any member may drive the bot there.
 */

import type { LarkLogger } from "../logger/logger.js";
import type { AccessState, AccessStore } from "./access-store.js";

export type AccessRole = "owner" | "admin" | "user";

export type ChatKind = "p2p" | "group";

export interface AccessRequest {
  /** Sender's Lark `open_id`. */
  readonly openId: string;
  readonly chatId: string;
  readonly chatType: ChatKind;
}

export type AccessDenyReason = "not_allowed_user" | "not_allowed_group";

export type AccessDecision =
  | {
      readonly allowed: true;
      readonly role: AccessRole;
      /** `true` when this request just claimed unowned ownership. */
      readonly ownerClaimed: boolean;
    }
  | { readonly allowed: false; readonly reason: AccessDenyReason };

/** Target of an `/invite` / `/remove` command. */
export type AccessTarget =
  | { readonly type: "user"; readonly openIds: readonly string[] }
  | { readonly type: "admin"; readonly openIds: readonly string[] }
  | { readonly type: "group" };

export interface AccessControlOptions {
  readonly store: AccessStore;
  readonly logger: LarkLogger;
  /**
   * Config-provided owner `open_id`. When set it always wins over the
   * persisted owner and disables first-contact ownership claiming.
   */
  readonly configuredOwner?: string;
}

export class AccessControl {
  private readonly store: AccessStore;
  private readonly logger: LarkLogger;
  private readonly configuredOwner: string | null;
  private state: AccessState;

  constructor(opts: AccessControlOptions) {
    this.store = opts.store;
    this.logger = opts.logger.child({ name: "access" });
    this.configuredOwner = opts.configuredOwner ?? null;
    this.state = opts.store.load();
  }

  /**
   * Initialise the backing store and load persisted state.
   *
   * @throws when the store fails to initialise.
   */
  async init(): Promise<void> {
    await this.store.init();
    this.state = this.store.load();
  }

  /** Flush any pending write and release the backing store. */
  async close(): Promise<void> {
    await this.store.close();
  }

  /** The effective owner: the configured one if set, else the claimed one. */
  private ownerOpenId(): string | null {
    return this.configuredOwner ?? this.state.owner;
  }

  /** Owner or admin — bypasses allowlists and may manage access. */
  isPrivileged(openId: string): boolean {
    const owner = this.ownerOpenId();
    if (owner !== null && openId === owner) return true;
    return this.state.admins.includes(openId);
  }

  /**
   * The role of a user for display (`/status`), with no side effects.
   * Everyone who isn't owner/admin is reported as `user` (message intake is
   * gated separately — a message reaching this point already passed access).
   */
  roleOf(openId: string): AccessRole {
    const owner = this.ownerOpenId();
    if (owner !== null && openId === owner) return "owner";
    if (this.state.admins.includes(openId)) return "admin";
    return "user";
  }

  /** Whether group messages must @-mention the bot to be handled. */
  requireMentionInGroup(): boolean {
    return this.state.requireMentionInGroup;
  }

  /**
   * Decide whether a message may be handled. Has one side effect: an
   * unconfigured, unclaimed owner is claimed by the first user to DM the
   * bot (persisted immediately).
   */
  evaluateMessage(req: AccessRequest): AccessDecision {
    const owner = this.ownerOpenId();

    if (owner === null) {
      // Unowned. Only a direct message can claim ownership — a random group
      // member must not be able to seize the bot.
      if (req.chatType === "p2p") {
        this.mutate((s) => ({ ...s, owner: req.openId }));
        this.logger.warn(
          { openId: req.openId },
          "no owner configured — first contact claimed ownership",
        );
        return { allowed: true, role: "owner", ownerClaimed: true };
      }
      return { allowed: false, reason: "not_allowed_group" };
    }

    if (req.openId === owner) return { allowed: true, role: "owner", ownerClaimed: false };
    if (this.state.admins.includes(req.openId)) {
      return { allowed: true, role: "admin", ownerClaimed: false };
    }

    if (req.chatType === "group") {
      if (this.state.groups.includes(req.chatId)) {
        return { allowed: true, role: "user", ownerClaimed: false };
      }
      return { allowed: false, reason: "not_allowed_group" };
    }

    if (this.state.users.includes(req.openId)) {
      return { allowed: true, role: "user", ownerClaimed: false };
    }
    return { allowed: false, reason: "not_allowed_user" };
  }

  // ----- Mutations --------------------------------------------------------

  /** Add users to the 1:1 allowlist. Returns the `open_id`s newly added. */
  grantUsers(openIds: readonly string[]): readonly string[] {
    return this.addTo("users", openIds);
  }

  /** Promote users to admin. Returns the `open_id`s newly promoted. */
  grantAdmins(openIds: readonly string[]): readonly string[] {
    return this.addTo("admins", openIds);
  }

  /** Allow a group. Returns `true` when it was newly added. */
  grantGroup(chatId: string): boolean {
    if (this.state.groups.includes(chatId)) return false;
    this.mutate((s) => ({ ...s, groups: [...s.groups, chatId] }));
    return true;
  }

  /** Remove users from the 1:1 allowlist. The owner can't be removed. */
  revokeUsers(openIds: readonly string[]): readonly string[] {
    return this.removeFrom("users", openIds);
  }

  /** Demote admins. The owner can't be demoted. */
  revokeAdmins(openIds: readonly string[]): readonly string[] {
    return this.removeFrom("admins", openIds);
  }

  /** Disallow a group. Returns `true` when it was present and removed. */
  revokeGroup(chatId: string): boolean {
    if (!this.state.groups.includes(chatId)) return false;
    this.mutate((s) => ({ ...s, groups: s.groups.filter((g) => g !== chatId) }));
    return true;
  }

  /** Set the group @-mention requirement. Returns `true` when it changed. */
  setRequireMentionInGroup(enabled: boolean): boolean {
    if (this.state.requireMentionInGroup === enabled) return false;
    this.mutate((s) => ({ ...s, requireMentionInGroup: enabled }));
    return true;
  }

  /** A read-only snapshot for display (`/access`). */
  snapshot(): AccessState & { readonly effectiveOwner: string | null } {
    return { ...this.state, effectiveOwner: this.ownerOpenId() };
  }

  private addTo(key: "users" | "admins", openIds: readonly string[]): readonly string[] {
    const owner = this.ownerOpenId();
    const current = new Set(this.state[key]);
    const added: string[] = [];
    for (const id of openIds) {
      // The owner is already maximally privileged; don't clutter lists with it.
      if (id === owner || current.has(id)) continue;
      current.add(id);
      added.push(id);
    }
    if (added.length > 0) this.mutate((s) => ({ ...s, [key]: [...current] }));
    return added;
  }

  private removeFrom(key: "users" | "admins", openIds: readonly string[]): readonly string[] {
    const owner = this.ownerOpenId();
    const toRemove = new Set(openIds);
    const removed = this.state[key].filter((id) => toRemove.has(id) && id !== owner);
    if (removed.length > 0) {
      const removedSet = new Set(removed);
      this.mutate((s) => ({ ...s, [key]: s[key].filter((id) => !removedSet.has(id)) }));
    }
    return removed;
  }

  private mutate(fn: (state: AccessState) => AccessState): void {
    this.state = fn(this.state);
    this.store.save(this.state);
  }
}
