/**
 * Blackbox e2e for the bundled Amazon Q ACP adapter (`dist/bin/q-acp.js`).
 *
 * Drives the built adapter over a real ACP `ClientSideConnection`, with a
 * fake `q` CLI standing in for Amazon Q (see tests/common.ts). Requires
 * `npm run build` first (wired via the `pretest` script).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createTestBed,
  initialize,
  spawnAdapter,
  type AdapterHandle,
  type TestBed,
} from "./common.js";

const ESC = String.fromCharCode(27);

describe("q-acp adapter", () => {
  let bed: TestBed;
  let adapter: AdapterHandle;

  beforeEach(() => {
    bed = createTestBed();
    adapter = spawnAdapter(bed);
  });

  afterEach(() => {
    adapter.kill();
    bed.cleanup();
  });

  it("advertises loadSession and text-only prompt capabilities", async () => {
    const init = await initialize(adapter);
    expect(init.agentCapabilities?.loadSession).toBe(true);
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(false);
  });

  it("streams the answer with ANSI stripped and finishes with end_turn", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: bed.dir, mcpServers: [] });

    const result = await adapter.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: "first question ABC" }],
    });

    const output = adapter.chunks.join("");
    expect(result.stopReason).toBe("end_turn");
    expect(output).toContain("Fake Q Answer");
    expect(output).toContain("Hello from fake q.");
    expect(output).not.toContain(ESC);
    expect(output).not.toContain("\r");
  });

  it("passes the raw prompt on turn 1 and replays history on turn 2", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: bed.dir, mcpServers: [] });

    await adapter.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: "first question ABC" }],
    });
    expect(bed.lastInput()).toBe("first question ABC");

    await adapter.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: "second question XYZ" }],
    });
    const replayed = bed.lastInput();
    expect(replayed).toContain("对话历史");
    expect(replayed).toContain("first question ABC");
    expect(replayed).toContain("Fake Q Answer");
    expect(replayed).toContain("second question XYZ");
  });

  it("always runs q non-interactively with tools trusted", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: bed.dir, mcpServers: [] });
    await adapter.conn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

    // The fixture IS the `chat` script (`node chat ...`), so "chat" itself is
    // consumed as node's script path — its presence is proven by the fixture
    // having run at all. The recorded argv starts at the first flag.
    const argv = bed.argvLog().at(-1);
    expect(argv).toBeDefined();
    expect(argv).toContain("--no-interactive");
    expect(argv).toContain("--trust-all-tools");
    expect(argv?.at(0)).toBe("--no-interactive");
  });

  it("persists the transcript and restores it via session/load in a new process", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: bed.dir, mcpServers: [] });
    await adapter.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: "first question ABC" }],
    });

    const sessionFile = path.join(bed.sessionsDir, `${sessionId}.json`);
    expect(fs.existsSync(sessionFile)).toBe(true);

    // Fresh adapter process = bridge restart.
    const revived = spawnAdapter(bed);
    try {
      await initialize(revived);
      await revived.conn.loadSession({ sessionId, cwd: bed.dir, mcpServers: [] });
      await revived.conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: "third question GHI" }],
      });
      expect(bed.lastInput()).toContain("first question ABC");
    } finally {
      revived.kill();
    }
  });

  it("rejects session/load for an unknown session id", async () => {
    await initialize(adapter);
    await expect(
      adapter.conn.loadSession({
        sessionId: "00000000-0000-0000-0000-000000000000",
        cwd: bed.dir,
        mcpServers: [],
      }),
    ).rejects.toThrow();
  });

  it("cancels a running turn with stopReason cancelled", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: bed.dir, mcpServers: [] });

    const promptPromise = adapter.conn.prompt({
      sessionId,
      prompt: [{ type: "text", text: "please SLEEP long" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await adapter.conn.cancel({ sessionId });

    const result = await promptPromise;
    expect(result.stopReason).toBe("cancelled");
  });

  it("surfaces q failures (non-zero exit) as prompt errors carrying stderr", async () => {
    await initialize(adapter);
    const { sessionId } = await adapter.conn.newSession({ cwd: bed.dir, mcpServers: [] });

    await expect(
      adapter.conn.prompt({ sessionId, prompt: [{ type: "text", text: "please FAIL now" }] }),
    ).rejects.toMatchObject({
      // acp.RequestError data carries the adapter's message, which embeds the stderr tail.
      data: { details: expect.stringContaining("not logged in") as unknown },
    });
  });
}, 20_000);
