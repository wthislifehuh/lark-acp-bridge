/**
 * Persistent access-control state: who is allowed to drive the bot, who
 * administers it, which groups it serves, and whether an @-mention is
 * required in groups.
 *
 * This is mutable at runtime (via `/invite` / `/remove` / `/mention`
 * commands) and lives in an atomically-written state file under the
 * bridge's `dataDir` — deliberately **not** in the user-owned
 * `config.json`, which is read once at startup.
 *
 * The library does **not** ship a default — callers construct a
 * {@link FileAccessStore} (or their own implementation) and hand it to
 * {@link AccessControl}.
 */

import { z } from "zod";

/**
 * The full, persisted access-control state.
 *
 * `owner` is a single Lark `open_id`. When a config-provided owner is
 * supplied to {@link AccessControl}, that always wins and this field is
 * left untouched; otherwise the first user to DM the bot claims it (see
 * {@link AccessControl.evaluateMessage}).
 */
export interface AccessState {
  /** Owner `open_id`, or `null` when unclaimed and unconfigured. */
  readonly owner: string | null;
  /** Admin `open_id`s — privileged like the owner but removable. */
  readonly admins: readonly string[];
  /** Allowed user `open_id`s (governs 1:1 chats). */
  readonly users: readonly string[];
  /** Allowed group `chat_id`s (any member may drive the bot there). */
  readonly groups: readonly string[];
  /** When `true`, group messages must @-mention the bot to be handled. */
  readonly requireMentionInGroup: boolean;
}

/** The empty starting state: no owner, nothing allowed, mention required. */
export const DEFAULT_ACCESS_STATE: AccessState = {
  owner: null,
  admins: [],
  users: [],
  groups: [],
  requireMentionInGroup: true,
};

export const accessStateSchema: z.ZodType<AccessState> = z.object({
  owner: z.string().nullable().default(null),
  admins: z.array(z.string()).default([]),
  users: z.array(z.string()).default([]),
  groups: z.array(z.string()).default([]),
  requireMentionInGroup: z.boolean().default(true),
});

export interface AccessStore {
  /**
   * Open / verify the underlying resource and load the current state. Must
   * be called before {@link load} / {@link save}.
   *
   * @throws when the underlying resource (file system) cannot be initialised.
   */
  init(): Promise<void>;

  /** The current persisted state (a stable snapshot loaded at {@link init}). */
  load(): AccessState;

  /** Replace the persisted state. Writes are coalesced and crash-safe. */
  save(state: AccessState): void;

  /** Flush any pending write and release handles. */
  close(): Promise<void>;
}
