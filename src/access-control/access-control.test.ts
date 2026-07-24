/**
 * White-box unit tests for {@link AccessControl} and its file-backed store.
 *
 * Covers the Phase-1 access-control acceptance criteria (architecture plan
 * §7): private-by-default, owner claim + config-owner precedence, allowlist
 * gating for DMs and groups, owner lock-out protection, the group @-mention
 * toggle, and persistence across a simulated restart.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccessControl } from "./access-control.js";
import { FileAccessStore } from "./file-access-store.js";
import type { AccessStore } from "./access-store.js";
import type { LarkLogger } from "../logger/logger.js";

const noopLogger: LarkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const OWNER = "ou_owner";
const ADMIN = "ou_admin";
const ALICE = "ou_alice";
const BOB = "ou_bob";
const GROUP = "oc_group";

async function makeAccess(store: AccessStore, configuredOwner?: string): Promise<AccessControl> {
  const ac = new AccessControl({
    store,
    logger: noopLogger,
    ...(configuredOwner !== undefined ? { configuredOwner } : {}),
  });
  await ac.init();
  return ac;
}

function dm(openId: string) {
  return { openId, chatId: `p2p_${openId}`, chatType: "p2p" as const };
}

function group(openId: string, chatId = GROUP) {
  return { openId, chatId, chatType: "group" as const };
}

describe("AccessControl", () => {
  let dir: string;
  let store: FileAccessStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-access-"));
    store = new FileAccessStore(dir);
  });

  afterEach(async () => {
    // Let any coalesced (setImmediate) flush complete before removing the
    // directory, otherwise the async write races the cleanup and throws.
    await store.close();
    await new Promise((resolve) => setImmediate(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("claims ownership on the first DM (private by default)", async () => {
    const ac = await makeAccess(store);
    const decision = ac.evaluateMessage(dm(ALICE));
    expect(decision).toEqual({ allowed: true, role: "owner", ownerClaimed: true });
    // Subsequent claimant is not the owner and has no allowance.
    expect(ac.evaluateMessage(dm(BOB))).toEqual({
      allowed: false,
      reason: "not_allowed_user",
    });
  });

  it("does not let a group message claim an unowned bot", async () => {
    const ac = await makeAccess(store);
    expect(ac.evaluateMessage(group(ALICE))).toEqual({
      allowed: false,
      reason: "not_allowed_group",
    });
  });

  it("honours a configured owner and never claims over it", async () => {
    const ac = await makeAccess(store, OWNER);
    expect(ac.evaluateMessage(dm(OWNER))).toEqual({
      allowed: true,
      role: "owner",
      ownerClaimed: false,
    });
    // A different first-DM user does not become owner when one is configured.
    expect(ac.evaluateMessage(dm(ALICE))).toEqual({
      allowed: false,
      reason: "not_allowed_user",
    });
  });

  it("lets owner and admins bypass allowlists in groups", async () => {
    const ac = await makeAccess(store, OWNER);
    ac.grantAdmins([ADMIN]);
    expect(ac.evaluateMessage(group(OWNER))).toMatchObject({ allowed: true, role: "owner" });
    expect(ac.evaluateMessage(group(ADMIN))).toMatchObject({ allowed: true, role: "admin" });
  });

  it("gates DMs by the user allowlist", async () => {
    const ac = await makeAccess(store, OWNER);
    expect(ac.evaluateMessage(dm(ALICE))).toEqual({
      allowed: false,
      reason: "not_allowed_user",
    });
    ac.grantUsers([ALICE]);
    expect(ac.evaluateMessage(dm(ALICE))).toMatchObject({ allowed: true, role: "user" });
    expect(ac.evaluateMessage(dm(BOB))).toEqual({ allowed: false, reason: "not_allowed_user" });
  });

  it("allows any member of an allowlisted group", async () => {
    const ac = await makeAccess(store, OWNER);
    expect(ac.evaluateMessage(group(ALICE))).toEqual({
      allowed: false,
      reason: "not_allowed_group",
    });
    ac.grantGroup(GROUP);
    expect(ac.evaluateMessage(group(ALICE))).toMatchObject({ allowed: true, role: "user" });
    expect(ac.evaluateMessage(group(BOB))).toMatchObject({ allowed: true, role: "user" });
    // A different group is still gated.
    expect(ac.evaluateMessage(group(ALICE, "oc_other"))).toEqual({
      allowed: false,
      reason: "not_allowed_group",
    });
  });

  it("reports newly-added entries and de-duplicates", async () => {
    const ac = await makeAccess(store, OWNER);
    expect(ac.grantUsers([ALICE, BOB])).toEqual([ALICE, BOB]);
    expect(ac.grantUsers([ALICE])).toEqual([]);
    expect(ac.grantGroup(GROUP)).toBe(true);
    expect(ac.grantGroup(GROUP)).toBe(false);
  });

  it("never removes or downgrades the owner", async () => {
    const ac = await makeAccess(store, OWNER);
    // Trying to add the owner to a list is a no-op; removing does nothing.
    expect(ac.grantAdmins([OWNER])).toEqual([]);
    expect(ac.revokeUsers([OWNER])).toEqual([]);
    expect(ac.revokeAdmins([OWNER])).toEqual([]);
    // Owner stays fully privileged.
    expect(ac.isPrivileged(OWNER)).toBe(true);
    expect(ac.evaluateMessage(dm(OWNER))).toMatchObject({ allowed: true, role: "owner" });
  });

  it("revokes users and demotes admins", async () => {
    const ac = await makeAccess(store, OWNER);
    ac.grantAdmins([ADMIN]);
    ac.grantUsers([ALICE]);
    expect(ac.revokeAdmins([ADMIN])).toEqual([ADMIN]);
    expect(ac.isPrivileged(ADMIN)).toBe(false);
    expect(ac.revokeUsers([ALICE])).toEqual([ALICE]);
    expect(ac.evaluateMessage(dm(ALICE))).toEqual({
      allowed: false,
      reason: "not_allowed_user",
    });
  });

  it("toggles the group @-mention requirement", async () => {
    const ac = await makeAccess(store, OWNER);
    expect(ac.requireMentionInGroup()).toBe(true);
    expect(ac.setRequireMentionInGroup(false)).toBe(true);
    expect(ac.requireMentionInGroup()).toBe(false);
    // Idempotent — no change reported when already set.
    expect(ac.setRequireMentionInGroup(false)).toBe(false);
  });

  it("persists mutations and reloads them (takes effect without restart)", async () => {
    const ac = await makeAccess(store, OWNER);
    ac.grantUsers([ALICE]);
    ac.grantGroup(GROUP);
    ac.setRequireMentionInGroup(false);
    await ac.close();

    // Simulate a fresh process: new store + control over the same dir.
    const reloaded = await makeAccess(new FileAccessStore(dir), OWNER);
    expect(reloaded.evaluateMessage(dm(ALICE))).toMatchObject({ allowed: true, role: "user" });
    expect(reloaded.evaluateMessage(group(BOB))).toMatchObject({ allowed: true, role: "user" });
    expect(reloaded.requireMentionInGroup()).toBe(false);
  });

  it("persists a first-contact ownership claim across a restart", async () => {
    const ac = await makeAccess(store);
    ac.evaluateMessage(dm(ALICE)); // ALICE claims ownership
    await ac.close();

    const reloaded = await makeAccess(new FileAccessStore(dir));
    expect(reloaded.isPrivileged(ALICE)).toBe(true);
    // A later user does not displace the claimed owner.
    expect(reloaded.evaluateMessage(dm(BOB))).toEqual({
      allowed: false,
      reason: "not_allowed_user",
    });
  });
});
