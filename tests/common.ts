/**
 * Shared setup for blackbox tests: spawn the built `dist/bin/q-acp.js`
 * adapter against a fake Amazon Q CLI, and speak real ACP to it via
 * `acp.ClientSideConnection`.
 *
 * The fake `q` trick: the adapter spawns `${Q_ACP_BIN} chat ...args`. We set
 * `Q_ACP_BIN` to the Node executable and place a script literally named
 * `chat` in the session cwd — so the adapter ends up running
 * `node chat --no-interactive ... -- <input>`, which executes our fixture.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as acp from "@agentclientprotocol/sdk";

export const ADAPTER_DIST = path.resolve("dist/bin/q-acp.js");

/**
 * Fake `q chat` fixture. Behavior keyed on the prompt text:
 *
 * - contains "SLEEP" → wait 4s before answering (lets tests cancel mid-turn;
 *   exits 143 on SIGTERM).
 * - contains "FAIL"  → exit 2 with a message on stderr.
 * - otherwise        → print a short ANSI-colored markdown answer and exit 0.
 *
 * Every invocation records its argv to `argv.log` and the resolved positional
 * input to `last-input.txt` (both in the fixture's directory) so tests can
 * assert on exactly what the adapter passed to "q".
 */
const FAKE_Q_CHAT_SOURCE = `
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const sep = args.indexOf("--");
const input = sep >= 0 ? args.slice(sep + 1).join(" ") : args[args.length - 1];
fs.writeFileSync(path.join(__dirname, "last-input.txt"), String(input), "utf8");
fs.appendFileSync(path.join(__dirname, "argv.log"), JSON.stringify(args) + "\\n");
const ESC = String.fromCharCode(27);
if (String(input).includes("SLEEP")) {
  const t = setTimeout(() => { process.stdout.write("late\\n"); process.exit(0); }, 4000);
  process.on("SIGTERM", () => { clearTimeout(t); process.exit(143); });
} else if (String(input).includes("FAIL")) {
  process.stderr.write("simulated q failure: not logged in\\n");
  process.exit(2);
} else {
  process.stdout.write(ESC + "[36m# Fake Q Answer" + ESC + "[0m\\n");
  process.stdout.write("Hello from fake q.\\r\\n");
  process.stdout.write(ESC + "[1mBold" + ESC + "[0m and \\\`code\\\`.");
  process.exit(0);
}
`;

export interface TestBed {
  /** Session cwd containing the fake `chat` fixture. */
  readonly dir: string;
  /** Where the adapter persists session transcripts. */
  readonly sessionsDir: string;
  /** Positional input the fake q received on its last invocation. */
  lastInput(): string;
  /** argv of every fake q invocation, oldest first. */
  argvLog(): string[][];
  cleanup(): void;
}

export function createTestBed(): TestBed {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qacp-test-"));
  const sessionsDir = path.join(dir, "sessions");
  fs.writeFileSync(path.join(dir, "chat"), FAKE_Q_CHAT_SOURCE, "utf8");
  return {
    dir,
    sessionsDir,
    lastInput: () => fs.readFileSync(path.join(dir, "last-input.txt"), "utf8"),
    argvLog: () =>
      fs
        .readFileSync(path.join(dir, "argv.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface AdapterHandle {
  readonly proc: ChildProcess;
  readonly conn: acp.ClientSideConnection;
  /** Text of every `agent_message_chunk` received, in order. */
  readonly chunks: string[];
  kill(): void;
}

/**
 * Spawn the built adapter and wrap it in a real ACP client connection.
 *
 * @throws if `dist/bin/q-acp.js` has not been built.
 */
export function spawnAdapter(bed: TestBed, extraEnv: Record<string, string> = {}): AdapterHandle {
  if (!fs.existsSync(ADAPTER_DIST)) {
    throw new Error(`adapter not built — run \`npm run build\` first (missing ${ADAPTER_DIST})`);
  }
  const proc = spawn(process.execPath, [ADAPTER_DIST], {
    env: {
      ...process.env,
      Q_ACP_BIN: process.execPath,
      Q_ACP_DATA_DIR: bed.sessionsDir,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const chunks: string[] = [];
  const client: acp.Client = {
    sessionUpdate(params: acp.SessionNotification): Promise<void> {
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
      return Promise.resolve();
    },
    requestPermission(): Promise<acp.RequestPermissionResponse> {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    },
    readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
      return Promise.resolve({ content: fs.readFileSync(params.path, "utf8") });
    },
    writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
      fs.writeFileSync(params.path, params.content, "utf8");
      return Promise.resolve({});
    },
  };

  // The piped-stdio spawn overload types stdin/stdout as non-null.
  const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
  const conn = new acp.ClientSideConnection(() => client, stream);

  return {
    proc,
    conn,
    chunks,
    kill: () => {
      if (!proc.killed && proc.exitCode === null) proc.kill();
    },
  };
}

export async function initialize(handle: AdapterHandle): Promise<acp.InitializeResponse> {
  return handle.conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
}
