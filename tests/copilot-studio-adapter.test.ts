/**
 * Blackbox e2e for the bundled Microsoft Copilot Studio ACP adapter
 * (`dist/bin/copilot-studio-acp.js`).
 *
 * Drives the built adapter over a real ACP `ClientSideConnection` against a
 * local fake Direct-to-Engine server (the SDK's `directConnectUrl` accepts
 * any URL and POSTs to `{url}/conversations[/{id}]`, streaming SSE
 * `event: activity` frames back). No Microsoft account involved: auth uses
 * the adapter's `static-token` mode. Requires `npm run build` first (wired
 * via the `pretest` script).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialize, spawnAdapterProcess, type AdapterHandle } from "./common.js";

const ADAPTER_DIST = path.resolve("dist/bin/copilot-studio-acp.js");
const CONVERSATION_ID = "test-conv-1";

interface RecordedTurn {
  readonly conversationId: string;
  readonly text: string;
}

interface FakeCopilotStudio {
  readonly url: string;
  /** Bodies of conversation-start requests, oldest first. */
  readonly starts: unknown[];
  /** Activities received on execute-turn requests, oldest first. */
  readonly turns: RecordedTurn[];
  failWithStatus: number | null;
  close(): Promise<void>;
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function typingChunk(streamSequence: number, text: string): unknown {
  return {
    type: "typing",
    text,
    conversation: { id: CONVERSATION_ID },
    entities: [{ type: "streaminfo", streamType: "streaming", streamId: "s1", streamSequence }],
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : null;
}

/**
 * Direct-to-Engine stand-in. Conversation start replies with a greeting
 * message; execute-turn replies keyed on the activity text:
 *
 * - contains "SLEEP" → first chunk, then a long pause (lets tests cancel).
 * - otherwise        → two accumulating typing chunks + the final message.
 */
function startFakeCopilotStudio(): Promise<FakeCopilotStudio> {
  const starts: unknown[] = [];
  const turns: RecordedTurn[] = [];
  const pendingTimers = new Set<NodeJS.Timeout>();

  const state: { failWithStatus: number | null } = { failWithStatus: null };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await readJsonBody(req);

      // Per-request 401 keyed on the turn's activity text — lets a test drive
      // one failing session concurrently with a healthy one.
      const activityText = (body as { activity?: { text?: string } }).activity?.text ?? "";
      if (state.failWithStatus !== null || activityText.includes("FAIL401")) {
        res.writeHead(state.failWithStatus ?? 401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "simulated upstream failure" } }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "x-ms-conversationid": CONVERSATION_ID,
      });

      if (url.pathname.endsWith(`/conversations/${CONVERSATION_ID}`)) {
        const request = body as { activity?: { text?: string } };
        const text = request.activity?.text ?? "";
        turns.push({ conversationId: CONVERSATION_ID, text });

        if (text.includes("SLEEP")) {
          res.write(sseFrame("activity", typingChunk(1, "开始处理…")));
          const timer = setTimeout(() => {
            res.write(
              sseFrame("activity", {
                type: "message",
                text: "太迟了",
                conversation: { id: CONVERSATION_ID },
              }),
            );
            res.write(sseFrame("end", {}));
            res.end();
          }, 4000);
          pendingTimers.add(timer);
          res.on("close", () => {
            clearTimeout(timer);
            pendingTimers.delete(timer);
          });
          return;
        }

        res.write(sseFrame("activity", typingChunk(1, "答案第一段")));
        res.write(sseFrame("activity", typingChunk(2, "，第二段")));
        res.write(
          sseFrame("activity", {
            type: "message",
            text: "答案第一段，第二段，收尾。",
            conversation: { id: CONVERSATION_ID },
            suggestedActions: {
              to: [],
              actions: [{ type: "imBack", title: "继续", value: "继续" }],
            },
          }),
        );
        res.write(sseFrame("end", {}));
        res.end();
        return;
      }

      // Conversation start.
      starts.push(body);
      res.write(
        sseFrame("activity", {
          type: "message",
          text: "你好，我是测试客服。",
          conversation: { id: CONVERSATION_ID },
        }),
      );
      res.write(sseFrame("end", {}));
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
        url: `http://127.0.0.1:${String(address.port)}/agent`,
        starts,
        turns,
        get failWithStatus() {
          return state.failWithStatus;
        },
        set failWithStatus(value: number | null) {
          state.failWithStatus = value;
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

describe("copilot-studio-acp adapter", () => {
  let fake: FakeCopilotStudio;
  let dataDir: string;
  let adapter: AdapterHandle;

  function spawnCopilotStudioAdapter(extraEnv: Record<string, string> = {}): AdapterHandle {
    return spawnAdapterProcess(ADAPTER_DIST, {
      COPILOT_STUDIO_DIRECT_CONNECT_URL: fake.url,
      COPILOT_STUDIO_STATIC_TOKEN: "test-token",
      COPILOT_STUDIO_DATA_DIR: dataDir,
      COPILOT_STUDIO_TURN_TIMEOUT_MS: "10000",
      ...extraEnv,
    });
  }

  beforeEach(async () => {
    fake = await startFakeCopilotStudio();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "csacp-test-"));
    adapter = spawnCopilotStudioAdapter();
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

  it("streams greeting + accumulated answer chunks without duplication", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });

    const result = await adapter.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: "帮我查订单" }],
    });

    expect(result.stopReason).toBe("end_turn");
    const output = adapter.chunks.join("");
    expect(output).toContain("你好，我是测试客服。");
    expect(output).toContain("答案第一段，第二段，收尾。");
    // The typing chunks and the final message overlap — text must appear once.
    expect(output.match(/答案第一段/g)).toHaveLength(1);
    expect(output).toContain("**Suggested actions**: 继续");
    expect(fake.turns).toEqual([{ conversationId: CONVERSATION_ID, text: "帮我查订单" }]);
  });

  it("reuses the server-side conversation across turns", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });

    await adapter.conn.prompt({ sessionId, prompt: [{ type: "text", text: "第一问" }] });
    await adapter.conn.prompt({ sessionId, prompt: [{ type: "text", text: "第二问" }] });

    expect(fake.starts).toHaveLength(1);
    expect(fake.turns.map((t) => t.text)).toEqual(["第一问", "第二问"]);
  });

  it("persists the conversation id and resumes via session/load in a new process", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });
    await adapter.conn.prompt({ sessionId, prompt: [{ type: "text", text: "第一问" }] });

    const revived = spawnCopilotStudioAdapter();
    try {
      await initialize(revived);
      await revived.conn.loadSession({ sessionId, cwd: dataDir, mcpServers: [] });
      await revived.conn.prompt({ sessionId, prompt: [{ type: "text", text: "接着上次" }] });
      // No second conversation start — the stored id was reused.
      expect(fake.starts).toHaveLength(1);
      expect(fake.turns.at(-1)?.text).toBe("接着上次");
    } finally {
      revived.kill();
    }
  });

  it("rejects session/load for an unknown session id", async () => {
    await initialize(adapter);
    await expect(
      adapter.conn.loadSession({
        sessionId: "00000000-0000-0000-0000-000000000000",
        cwd: dataDir,
        mcpServers: [],
      }),
    ).rejects.toThrow();
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

  it("surfaces upstream 401 as an authentication error instead of hanging", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });

    fake.failWithStatus = 401;
    await expect(
      adapter.conn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toMatchObject({
      data: { details: expect.stringContaining("Authentication required") as unknown },
    });
  });

  it("isolates a failing session's upstream error from a concurrent healthy session", async () => {
    // Regression: upstream failures are recorded per-turn (AsyncLocalStorage),
    // so a 401 in session A must not be dropped by session B's concurrent turn
    // (and B's success must not be corrupted by A's failure).
    await initialize(adapter);
    const a = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });
    const b = await adapter.conn.newSession({ cwd: dataDir, mcpServers: [] });

    const [aResult, bResult] = await Promise.allSettled([
      adapter.conn.prompt({
        sessionId: a.sessionId,
        prompt: [{ type: "text", text: "FAIL401 请失败" }],
      }),
      adapter.conn.prompt({ sessionId: b.sessionId, prompt: [{ type: "text", text: "正常问题" }] }),
    ]);

    expect(aResult.status).toBe("rejected");
    if (aResult.status === "rejected") {
      expect(String((aResult.reason as { data?: { details?: string } }).data?.details)).toContain(
        "Authentication required",
      );
    }
    expect(bResult.status).toBe("fulfilled");
    if (bResult.status === "fulfilled") {
      expect(bResult.value.stopReason).toBe("end_turn");
    }
    expect(adapter.chunks.join("")).toContain("答案第一段，第二段，收尾。");
  });
}, 30_000);
