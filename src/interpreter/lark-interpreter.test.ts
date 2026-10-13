/**
 * White-box unit tests for access-command parsing in the interpreter:
 * `/invite` / `/remove` / `/access` / `/mention`, including mention-target
 * extraction (needed for `/invite user @name`) and bot self-mention
 * stripping in groups.
 */

import { describe, expect, it } from "vitest";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { interpretLarkMessage } from "./lark-interpreter.js";

const BOT = "ou_bot";
const ALICE = "ou_alice";
const BOB = "ou_bob";

type Mention = NonNullable<Lark.RawMessageEvent["message"]["mentions"]>[number];

function textEvent(
  text: string,
  mentions: Mention[] = [],
  chatType: "p2p" | "group" = "p2p",
): Lark.RawMessageEvent {
  return {
    sender: { sender_id: { open_id: ALICE }, sender_type: "user" },
    message: {
      message_id: "m1",
      chat_id: "c1",
      chat_type: chatType,
      message_type: "text",
      content: JSON.stringify({ text }),
      mentions,
    },
  };
}

function mention(key: string, openId: string, name: string): Mention {
  return { key, id: { open_id: openId }, name };
}

describe("interpreter command parsing", () => {
  it("still recognises session commands", () => {
    expect(interpretLarkMessage(textEvent("/cancel"))).toEqual({
      kind: "command",
      command: { kind: "cancel" },
    });
    expect(interpretLarkMessage(textEvent("/new"))).toEqual({
      kind: "command",
      command: { kind: "new" },
    });
  });

  it("parses operability commands (slash + Chinese aliases)", () => {
    expect(interpretLarkMessage(textEvent("/help"))).toEqual({
      kind: "command",
      command: { kind: "help" },
    });
    expect(interpretLarkMessage(textEvent("帮助"))).toEqual({
      kind: "command",
      command: { kind: "help" },
    });
    expect(interpretLarkMessage(textEvent("/status"))).toEqual({
      kind: "command",
      command: { kind: "status" },
    });
    expect(interpretLarkMessage(textEvent("状态"))).toEqual({
      kind: "command",
      command: { kind: "status" },
    });
    expect(interpretLarkMessage(textEvent("/config"))).toEqual({
      kind: "command",
      command: { kind: "config" },
    });
    expect(interpretLarkMessage(textEvent("配置"))).toEqual({
      kind: "command",
      command: { kind: "config" },
    });
  });

  it("parses /access", () => {
    expect(interpretLarkMessage(textEvent("/access"))).toEqual({
      kind: "command",
      command: { kind: "access-show" },
    });
  });

  it("parses /mention on|off and reports usage otherwise", () => {
    expect(interpretLarkMessage(textEvent("/mention on"))).toEqual({
      kind: "command",
      command: { kind: "mention-toggle", enabled: true },
    });
    expect(interpretLarkMessage(textEvent("/mention off"))).toEqual({
      kind: "command",
      command: { kind: "mention-toggle", enabled: false },
    });
    const usage = interpretLarkMessage(textEvent("/mention"));
    expect(usage).toMatchObject({ kind: "command", command: { kind: "access-usage" } });
  });

  it("parses /invite user with mention targets", () => {
    const result = interpretLarkMessage(
      textEvent("/invite user @_user_1 @_user_2", [
        mention("@_user_1", ALICE, "Alice"),
        mention("@_user_2", BOB, "Bob"),
      ]),
    );
    expect(result).toEqual({
      kind: "command",
      command: { kind: "invite", target: { type: "user", openIds: [ALICE, BOB] } },
    });
  });

  it("parses /invite group without mentions", () => {
    expect(interpretLarkMessage(textEvent("/invite group"))).toEqual({
      kind: "command",
      command: { kind: "invite", target: { type: "group" } },
    });
  });

  it("parses /remove admin with mention target", () => {
    const result = interpretLarkMessage(
      textEvent("/remove admin @_user_1", [mention("@_user_1", ALICE, "Alice")]),
    );
    expect(result).toEqual({
      kind: "command",
      command: { kind: "remove", target: { type: "admin", openIds: [ALICE] } },
    });
  });

  it("returns usage when /invite user has no mention target", () => {
    expect(interpretLarkMessage(textEvent("/invite user"))).toMatchObject({
      kind: "command",
      command: { kind: "access-usage" },
    });
  });

  it("excludes the bot's own mention from invite targets in a group", () => {
    const result = interpretLarkMessage(
      textEvent(
        "@_bot /invite user @_user_1",
        [mention("@_bot", BOT, "Bot"), mention("@_user_1", ALICE, "Alice")],
        "group",
      ),
      { botOpenId: BOT },
    );
    expect(result).toEqual({
      kind: "command",
      command: { kind: "invite", target: { type: "user", openIds: [ALICE] } },
    });
  });

  it("treats an unknown slash token as a normal prompt", () => {
    const result = interpretLarkMessage(textEvent("/deploy the app"));
    expect(result).toMatchObject({ kind: "prompt" });
  });

  it("treats ordinary text as a prompt", () => {
    const result = interpretLarkMessage(textEvent("hello there"));
    expect(result).toEqual({
      kind: "prompt",
      blocks: [{ type: "text", text: "hello there" }],
    });
  });
});
