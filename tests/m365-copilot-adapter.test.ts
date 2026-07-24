/**
 * Blackbox e2e for the bundled Microsoft 365 Copilot ACP adapter
 * (`dist/bin/m365-copilot-acp.js`).
 *
 * Drives the built adapter over a real ACP `ClientSideConnection` against a
 * local fake of the Graph Chat API (`POST /copilot/conversations`, then
 * `/chat` / `/chatOverStream` with cumulative-snapshot SSE — the documented
 * beta contract). No Microsoft account involved: auth uses
 * `M365_COPILOT_STATIC_TOKEN`. Requires `npm run build` first (wired via the
 * `pretest` script).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialize, spawnAdapterProcess, type AdapterHandle } from "./common.js";

const ADAPTER_DIST = path.resolve("dist/bin/m365-copilot-acp.js");
const CONVERSATION_ID = "m365-conv-1";

const FINAL_ANSWER_RAW = "你的会议是 <Event>工程周会</Event>，组织者 <Person>张三</Person>[^1^]。";
const FINAL_ANSWER_CLEAN = "你的会议是 工程周会，组织者 张三[1]。";

interface RecordedChat {
  readonly conversationId: string;
  readonly endpoint: "chat" | "chatOverStream";
  readonly body: { message?: { text?: string }; locationHint?: { timeZone?: string } };
}

interface FakeGraph {
  readonly baseUrl: string;
  createCount(): number;
  readonly chats: RecordedChat[];
  failWithStatus: number | null;
  /** Delay (ms) before answering `POST /conversations` — opens a cancel window. */
  createDelayMs: number;
  close(): Promise<void>;
}

function snapshot(messages: unknown[]): unknown {
  return { id: CONVERSATION_ID, state: "active", turnCount: 1, messages };
}

function responseMessage(text: string, attributions: unknown[] = []): unknown {
  return {
    "@odata.type": "#microsoft.graph.copilotConversationResponseMessage",
    id: "msg-1",
    text,
    attributions,
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : null;
}

/**
 * Graph Chat API stand-in. `chatOverStream` behavior keyed on prompt text:
 *
 * - contains "SLEEP" → first partial snapshot, then a long pause (for the
 *   cancel test).
 * - otherwise        → two cumulative snapshots (partial → final incl. the
 *   echoed user prompt + a citation), then stream close.
 */
function startFakeGraph(): Promise<FakeGraph> {
  const chats: RecordedChat[] = [];
  const pendingTimers = new Set<NodeJS.Timeout>();
  const state: { failWithStatus: number | null; created: number; createDelayMs: number } = {
    failWithStatus: null,
    created: 0,
    createDelayMs: 0,
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await readJsonBody(req);

      if (state.failWithStatus !== null) {
        res.writeHead(state.failWithStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "Forbidden", message: "simulated" } }));
        return;
      }

      if (url.pathname === "/beta/copilot/conversations") {
        state.created += 1;
        const reply = (): void => {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: CONVERSATION_ID, status: "active", turnCount: 0 }));
        };
        if (state.createDelayMs > 0) {
          const timer = setTimeout(reply, state.createDelayMs);
          pendingTimers.add(timer);
          res.on("close", () => {
            clearTimeout(timer);
            pendingTimers.delete(timer);
          });
        } else {
          reply();
        }
        return;
      }

      const chatMatch = /^\/beta\/copilot\/conversations\/([^/]+)\/(chat|chatOverStream)$/.exec(
        url.pathname,
      );
      if (!chatMatch) {
        res.writeHead(404).end();
        return;
      }
      const conversationId = chatMatch[1] ?? "";
      const endpoint = chatMatch[2] === "chat" ? ("chat" as const) : ("chatOverStream" as const);
      const chatBody = (body ?? {}) as RecordedChat["body"];
      chats.push({ conversationId, endpoint, body: chatBody });
      const promptText = chatBody.message?.text ?? "";

      if (endpoint === "chat") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            snapshot([responseMessage(promptText), responseMessage(FINAL_ANSWER_RAW)]),
          ),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(
        `data: ${JSON.stringify(snapshot([responseMessage("你的会议是 <Event>工程周会")]))}\nid:1\n\n`,
      );

      if (promptText.includes("SLEEP")) {
        const timer = setTimeout(() => {
          res.write(
            `data: ${JSON.stringify(snapshot([responseMessage(FINAL_ANSWER_RAW)]))}\nid:2\n\n`,
          );
          res.end();
        }, 4000);
        pendingTimers.add(timer);
        res.on("close", () => {
          clearTimeout(timer);
          pendingTimers.delete(timer);
        });
        return;
      }

      res.write(
        `data: ${JSON.stringify(
          snapshot([
            responseMessage(promptText),
            responseMessage(FINAL_ANSWER_RAW, [
              {
                attributionType: "citation",
                providerDisplayName: "工程周会",
                seeMoreWebUrl: "https://teams.example.com/meeting/1",
              },
            ]),
          ]),
        )}\nid:2\n\n`,
      );
      res.end();
    })().catch(() => {
      res.destroy();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("fake server has no port");
      }
      resolve({
        baseUrl: `http://127.0.0.1:${String(address.port)}/beta`,
        createCount: () => state.created,
        chats,
        get failWithStatus() {
          return state.failWithStatus;
        },
        set failWithStatus(value: number | null) {
          state.failWithStatus = value;
        },
        get createDelayMs() {
          return state.createDelayMs;
        },
        set createDelayMs(value: number) {
          state.createDelayMs = value;
        },
        close: () => {
          for (const timer of pendingTimers) clearTimeout(timer);
          return new Promise<void>((res2) => {
            server.close(() => {
              res2();
            });
            server.closeAllConnections();
          });
        },
      });
    });
  });
}

describe("m365-copilot-acp adapter", () => {
  let fake: FakeGraph;
  let dataDir: string;
  let adapter: AdapterHandle;

  function spawnM365Adapter(extraEnv: Record<string, string> = {}): AdapterHandle {
    return spawnAdapterProcess(ADAPTER_DIST, {
      M365_COPILOT_BASE_URL: fake.baseUrl,
      M365_COPILOT_STATIC_TOKEN: "test-token",
      M365_COPILOT_TIMEZONE: "Asia/Shanghai",
      M365_COPILOT_DATA_DIR: dataDir,
      M365_COPILOT_TURN_TIMEOUT_MS: "10000",
      ...extraEnv,
    });
  }

  beforeEach(async () => {
    fake = await startFakeGraph();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "m365acp-test-"));
    adapter = spawnM365Adapter();
  });

  afterEach(async () => {
    adapter.kill();
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("advertises loadSession and text-only prompt capabilities", async () => {
    const init = await initialize(adapter);
    expect(init.agentCapabilities?.loadSession).toBe(true);
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(false);
  });

  it("streams cleaned snapshot deltas plus citations, sending the required locationHint", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });

    const result = await adapter.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: "明早有什么会？" }],
    });

    expect(result.stopReason).toBe("end_turn");
    const output = adapter.chunks.join("");
    expect(output).toContain(FINAL_ANSWER_CLEAN);
    // Cumulative snapshots must not duplicate the prefix.
    expect(output.match(/工程周会，组织者/g)).toHaveLength(1);
    expect(output).not.toContain("<Event>");
    expect(output).toContain("**Sources**");
    expect(output).toContain("[工程周会](https://teams.example.com/meeting/1)");

    expect(fake.createCount()).toBe(1);
    const chat = fake.chats.at(-1);
    expect(chat?.endpoint).toBe("chatOverStream");
    expect(chat?.body.message?.text).toBe("明早有什么会？");
    expect(chat?.body.locationHint?.timeZone).toBe("Asia/Shanghai");
  });

  it("reuses the Graph conversation across turns", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });

    await adapter.conn.prompt({ sessionId, prompt: [{ type: "text", text: "第一问" }] });
    await adapter.conn.prompt({ sessionId, prompt: [{ type: "text", text: "第二问" }] });

    expect(fake.createCount()).toBe(1);
    expect(fake.chats.map((c) => c.conversationId)).toEqual([CONVERSATION_ID, CONVERSATION_ID]);
  });

  it("persists the conversation id and resumes via session/load in a new process", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });
    await adapter.conn.prompt({ sessionId, prompt: [{ type: "text", text: "第一问" }] });

    const revived = spawnM365Adapter();
    try {
      await initialize(revived);
      await revived.conn.loadSession({ sessionId, cwd: dataDir, mcpServers: [] });
      await revived.conn.prompt({ sessionId, prompt: [{ type: "text", text: "接着上次" }] });
      expect(fake.createCount()).toBe(1);
      expect(fake.chats.at(-1)?.conversationId).toBe(CONVERSATION_ID);
    } finally {
      revived.kill();
    }
  });

  it("supports the synchronous chat endpoint when streaming is disabled", async () => {
    const syncAdapter = spawnM365Adapter({ M365_COPILOT_STREAMING: "false" });
    try {
      await initialize(syncAdapter);
      const { sessionId } = await syncAdapter.conn.newSession({ cwd: dataDir, mcpServers: [] });
      const result = await syncAdapter.conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: "同步问题" }],
      });
      expect(result.stopReason).toBe("end_turn");
      expect(syncAdapter.chunks.join("")).toContain(FINAL_ANSWER_CLEAN);
      expect(fake.chats.at(-1)?.endpoint).toBe("chat");
    } finally {
      syncAdapter.kill();
    }
  });

  it("cancels a running turn with stopReason cancelled", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });

    const promptPromise = adapter.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: "please SLEEP long" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await adapter.conn.cancel({ sessionId });

    const result = await promptPromise;
    expect(result.stopReason).toBe("cancelled");
  });

  it("honors a cancel during lazy conversation creation without streaming an answer", async () => {
    // Regression: the abort controller must exist before createConversation so a
    // cancel in that pre-turn window is not dropped (which would let a cancelled
    // turn stream its full answer and return end_turn).
    fake.createDelayMs = 1500;
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });

    const promptPromise = adapter.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: "first question" }],
    });
    // Cancel while the conversation-creation request is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await adapter.conn.cancel({ sessionId });

    const result = await promptPromise;
    expect(result.stopReason).toBe("cancelled");
    // No chat turn was ever issued, and nothing was streamed to the card.
    expect(fake.chats).toHaveLength(0);
    expect(adapter.chunks.join("")).toBe("");
  });

  it("surfaces upstream 403 as an authentication/licensing error", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });

    fake.failWithStatus = 403;
    await expect(
      adapter.conn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toMatchObject({
      data: { details: expect.stringContaining("Authentication required") as unknown },
    });
  });
}, 30_000);
