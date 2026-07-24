/**
 * White-box unit tests for the Lark MCP tool server
 * (`docs/lark-mcp-tool-server.md`): the per-chat token registry and the
 * interactive `ask_choice` promise-bridge, whose operator-binding mirrors the
 * permission-card rule (plan §4.1).
 */

import { describe, expect, it } from "vitest";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";
import type { CardActionClicker } from "../acp/lark-acp-client.js";
import { ToolContext, AskTimeoutError } from "./tool-context.js";
import { LarkToolServer } from "./lark-tool-server.js";

const noopLogger: LarkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const OPERATOR = "ou_operator";
const OTHER = "ou_other";

function operatorClicker(openId: string, privileged = false): CardActionClicker {
  return { openId, privileged };
}

interface FakeHttp {
  readonly http: LarkHttpClient;
  readonly sent: object[];
  readonly patched: { id: string; card: object }[];
}

function makeHttp(): FakeHttp {
  const sent: object[] = [];
  const patched: { id: string; card: object }[] = [];
  let n = 0;
  const stub = {
    sendCardToChat: (_chatId: string, card: object): Promise<string | null> => {
      sent.push(card);
      n += 1;
      return Promise.resolve(`card_${String(n)}`);
    },
    patchCard: (id: string, card: object): Promise<void> => {
      patched.push({ id, card });
      return Promise.resolve();
    },
    downloadMessageResource: (): Promise<{ bytes: Buffer; mimeType: string }> =>
      Promise.resolve({ bytes: Buffer.from("hi"), mimeType: "text/plain" }),
  };
  return { http: stub as unknown as LarkHttpClient, sent, patched };
}

/** Pull the generated ask id + option ids out of a captured choice card. */
function readChoiceCard(card: object): { askId: string; optionIds: string[] } {
  const typed = card as {
    body: { elements: { tag: string; behaviors?: { value: { ask?: string; opt?: string } }[] }[] };
  };
  const buttons = typed.body.elements.filter((e) => e.tag === "button");
  const first = buttons[0]?.behaviors?.[0]?.value.ask ?? "";
  const optionIds = buttons.map((b) => b.behaviors?.[0]?.value.opt ?? "");
  return { askId: first, optionIds };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("ToolContext.askChoice operator binding", () => {
  it("resolves when the originating operator answers", async () => {
    const { http, sent, patched } = makeHttp();
    const ctx = new ToolContext({ chatId: "c1", http, logger: noopLogger, askTimeoutMs: 0 });
    ctx.setOperator(OPERATOR);

    const result = ctx.askChoice("Pick one", ["Apple", "Banana"]);
    await flush();
    const { askId, optionIds } = readChoiceCard(sent[0]!);

    expect(ctx.resolveAsk(askId, optionIds[1] ?? "", operatorClicker(OPERATOR))).toBe("resolved");
    await expect(result).resolves.toEqual({ optionId: "opt1", label: "Banana" });
    // resolved card patched once.
    expect(patched).toHaveLength(1);
  });

  it("rejects a non-operator click and leaves the ask pending", async () => {
    const { http, sent } = makeHttp();
    const ctx = new ToolContext({ chatId: "c1", http, logger: noopLogger, askTimeoutMs: 0 });
    ctx.setOperator(OPERATOR);

    const result = ctx.askChoice("Pick", ["A", "B"]);
    await flush();
    const { askId } = readChoiceCard(sent[0]!);

    expect(ctx.resolveAsk(askId, "opt0", operatorClicker(OTHER))).toBe("forbidden");
    // still resolvable by the real operator afterwards.
    expect(ctx.resolveAsk(askId, "opt0", operatorClicker(OPERATOR))).toBe("resolved");
    await expect(result).resolves.toEqual({ optionId: "opt0", label: "A" });
  });

  it("lets a privileged user answer another operator's ask", async () => {
    const { http, sent } = makeHttp();
    const ctx = new ToolContext({ chatId: "c1", http, logger: noopLogger, askTimeoutMs: 0 });
    ctx.setOperator(OPERATOR);

    const result = ctx.askChoice("Pick", ["A", "B"]);
    await flush();
    const { askId } = readChoiceCard(sent[0]!);

    expect(ctx.resolveAsk(askId, "opt1", operatorClicker(OTHER, true))).toBe("resolved");
    await expect(result).resolves.toEqual({ optionId: "opt1", label: "B" });
  });

  it("reports an unknown ask id as orphan", () => {
    const { http } = makeHttp();
    const ctx = new ToolContext({ chatId: "c1", http, logger: noopLogger, askTimeoutMs: 0 });
    expect(ctx.resolveAsk("nope", "opt0", operatorClicker(OPERATOR))).toBe("orphan");
  });

  it("times out an unanswered ask", async () => {
    const { http } = makeHttp();
    const ctx = new ToolContext({ chatId: "c1", http, logger: noopLogger, askTimeoutMs: 10 });
    ctx.setOperator(OPERATOR);
    await expect(ctx.askChoice("Pick", ["A", "B"])).rejects.toBeInstanceOf(AskTimeoutError);
  });

  it("fails pending asks on dispose", async () => {
    const { http, sent } = makeHttp();
    const ctx = new ToolContext({ chatId: "c1", http, logger: noopLogger, askTimeoutMs: 0 });
    ctx.setOperator(OPERATOR);
    const result = ctx.askChoice("Pick", ["A", "B"]);
    await flush();
    void sent;
    ctx.dispose();
    await expect(result).rejects.toBeInstanceOf(AskTimeoutError);
  });
});

describe("LarkToolServer registry", () => {
  it("registers a chat and returns a loopback http config", async () => {
    const { http } = makeHttp();
    const server = new LarkToolServer({ http, logger: noopLogger, askTimeoutMs: 0 });
    await server.start();
    try {
      const cfg = server.register("chatA");
      expect(cfg.type).toBe("http");
      expect(cfg.name).toBe("lark");
      expect(cfg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f-]+$/);
      expect(server.contextForChat("chatA")).toBeInstanceOf(ToolContext);
      // idempotent: same token for the same chat.
      expect(server.register("chatA").url).toBe(cfg.url);
    } finally {
      await server.stop();
    }
  });

  it("routes resolveAsk to the chat, orphan for unknown chats", async () => {
    const { http, sent } = makeHttp();
    const server = new LarkToolServer({ http, logger: noopLogger, askTimeoutMs: 0 });
    await server.start();
    try {
      server.register("chatA");
      const ctx = server.contextForChat("chatA");
      expect(ctx).toBeDefined();
      ctx?.setOperator(OPERATOR);
      const result = ctx?.askChoice("Q", ["A", "B"]);
      await flush();
      const { askId } = readChoiceCard(sent[0]!);

      expect(server.resolveAsk("ghost", askId, "opt0", operatorClicker(OPERATOR))).toBe("orphan");
      expect(server.resolveAsk("chatA", askId, "opt0", operatorClicker(OPERATOR))).toBe("resolved");
      await expect(result).resolves.toEqual({ optionId: "opt0", label: "A" });
    } finally {
      await server.stop();
    }
  });

  it("unregisters a chat and disposes its context", async () => {
    const { http } = makeHttp();
    const server = new LarkToolServer({ http, logger: noopLogger, askTimeoutMs: 0 });
    await server.start();
    try {
      server.register("chatA");
      await server.unregister("chatA");
      expect(server.contextForChat("chatA")).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("throws when registering before start()", () => {
    const { http } = makeHttp();
    const server = new LarkToolServer({ http, logger: noopLogger, askTimeoutMs: 0 });
    expect(() => server.register("chatA")).toThrow();
  });
});
