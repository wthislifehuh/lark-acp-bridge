/**
 * White-box unit tests for {@link Identity}: the `lark-cli` identity-policy
 * environment injection and the prompt-context block (architecture plan
 * item #2).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Identity, IDENTITY_ENV, isIdentityPolicy } from "./identity.js";
import type { IdentityOptions, IdentityPolicy } from "./identity.js";
import type { LarkLogger } from "../logger/logger.js";

const noopLogger: LarkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const APP_ID = "cli_app";
const APP_SECRET = "secret_value";
const CHAT = "oc_chat";
const USER = "ou_user";

describe("isIdentityPolicy", () => {
  it("accepts known policies and rejects others", () => {
    expect(isIdentityPolicy("bot-only")).toBe(true);
    expect(isIdentityPolicy("user-default")).toBe(true);
    expect(isIdentityPolicy("root")).toBe(false);
  });
});

describe("Identity", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-identity-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function make(overrides: Partial<IdentityOptions> = {}): Identity {
    return new Identity({
      policy: "bot-only",
      configDir: path.join(dir, "lark-cli"),
      injectCredentials: false,
      injectPromptContext: true,
      appId: APP_ID,
      appSecret: APP_SECRET,
      domain: "lark",
      logger: noopLogger,
      ...overrides,
    });
  }

  it("injects policy, chat id, config dir and domain (no credentials by default)", () => {
    const identity = make();
    const env = identity.agentEnv(CHAT);
    expect(env[IDENTITY_ENV.policy]).toBe("bot-only");
    expect(env[IDENTITY_ENV.chatId]).toBe(CHAT);
    expect(env[IDENTITY_ENV.configDir]).toBe(path.join(dir, "lark-cli"));
    expect(env[IDENTITY_ENV.domain]).toBe("lark");
    expect(env[IDENTITY_ENV.appId]).toBeUndefined();
    expect(env[IDENTITY_ENV.appSecret]).toBeUndefined();
  });

  it("creates the config directory on first env build", () => {
    const configDir = path.join(dir, "lark-cli");
    expect(fs.existsSync(configDir)).toBe(false);
    make().agentEnv(CHAT);
    expect(fs.existsSync(configDir)).toBe(true);
  });

  it("injects credentials only when opted in", () => {
    const env = make({ injectCredentials: true }).agentEnv(CHAT);
    expect(env[IDENTITY_ENV.appId]).toBe(APP_ID);
    expect(env[IDENTITY_ENV.appSecret]).toBe(APP_SECRET);
  });

  it("omits the domain var when no domain is configured", () => {
    const identity = new Identity({
      policy: "bot-only",
      configDir: path.join(dir, "lark-cli"),
      injectCredentials: false,
      injectPromptContext: true,
      appId: APP_ID,
      appSecret: APP_SECRET,
      logger: noopLogger,
    });
    expect(identity.agentEnv(CHAT)[IDENTITY_ENV.domain]).toBeUndefined();
  });

  it("builds a p2p prompt-context block with the bot-only note", () => {
    const ctx = make().promptContext({
      chatType: "p2p",
      chatId: CHAT,
      userId: USER,
      userName: "Alice",
    });
    expect(ctx).toContain("私聊");
    expect(ctx).toContain(USER);
    expect(ctx).toContain("bot-only");
  });

  it("builds a group prompt-context block including the chat name", () => {
    const ctx = make().promptContext({
      chatType: "group",
      chatId: CHAT,
      chatName: "Ops",
      userId: USER,
      userName: "Alice",
    });
    expect(ctx).toContain("群聊");
    expect(ctx).toContain("Ops");
    expect(ctx).toContain(CHAT);
  });

  it("adds an act-as note under user-default", () => {
    const ctx = make({ policy: "user-default" }).promptContext({
      chatType: "p2p",
      chatId: CHAT,
      userId: USER,
      userName: "Alice",
    });
    expect(ctx).toContain("user-default");
    expect(ctx).toContain(USER);
  });

  it("returns null when prompt-context injection is disabled", () => {
    const ctx = make({ injectPromptContext: false }).promptContext({
      chatType: "p2p",
      chatId: CHAT,
      userId: USER,
      userName: "Alice",
    });
    expect(ctx).toBeNull();
  });

  it("exposes the configured policy", () => {
    const policy: IdentityPolicy = "user-default";
    expect(make({ policy }).policy).toBe("user-default");
  });
});
