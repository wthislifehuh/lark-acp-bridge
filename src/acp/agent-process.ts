import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";

const STDIO_PIPED: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
const WIN32_PLATFORM = "win32";
const STDERR_BUFFER_LINES = 50;

export interface AgentProcess {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  capabilities: Record<string, unknown>;
  /** Most recent stderr lines (up to {@link STDERR_BUFFER_LINES}). */
  getRecentStderr: () => readonly string[];
}

export interface SpawnAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: acp.Client;
  logger: LarkLogger;
}

interface SpawnInternal {
  proc: ChildProcess;
  connection: acp.ClientSideConnection;
  initResult: acp.InitializeResponse;
  getRecentStderr: () => readonly string[];
}

/**
 * Spawn an agent subprocess, run the ACP handshake, and create a fresh
 * session.
 *
 * @throws when the agent process cannot be initialized (binary missing,
 *         protocol mismatch, etc.) or when `newSession` rejects.
 */
export async function spawnAgent(opts: SpawnAgentOptions): Promise<AgentProcess> {
  const { proc, connection, initResult, getRecentStderr } = await spawnAndInit(opts);

  let sessionResult: acp.NewSessionResponse;
  try {
    sessionResult = await connection.newSession({ cwd: opts.cwd, mcpServers: [] });
  } catch (err) {
    throw new Error("Failed to create agent session", { cause: err });
  }
  opts.logger.info({ sessionId: sessionResult.sessionId }, "agent session created");

  return {
    process: proc,
    connection,
    sessionId: sessionResult.sessionId,
    capabilities: initResult.agentCapabilities ?? {},
    getRecentStderr,
  };
}

/**
 * Spawn an agent and try to resume an existing session. Falls back to
 * `loadSession` if `unstable_resumeSession` is unavailable, then to a
 * fresh session if neither resume mechanism works.
 *
 * @throws on unrecoverable spawn / init failures (same conditions as
 *         {@link spawnAgent}).
 */
export async function spawnAndResumeAgent(
  opts: SpawnAgentOptions,
  previousSessionId: string,
): Promise<{ agent: AgentProcess; resumed: boolean }> {
  const { proc, connection, initResult, getRecentStderr } = await spawnAndInit(opts);
  const agentCaps = initResult.agentCapabilities;
  const caps = (agentCaps ?? {}) as Record<string, unknown>;

  const hasResume = !!agentCaps?.sessionCapabilities?.resume;
  const hasLoad = !!agentCaps?.loadSession;

  opts.logger.debug({ hasResume, hasLoad, previousSessionId }, "agent capabilities for resume");

  if (hasResume || hasLoad) {
    try {
      if (hasResume) {
        await connection.resumeSession({
          sessionId: previousSessionId,
          cwd: opts.cwd,
          mcpServers: [],
        });
      } else {
        await connection.loadSession({
          sessionId: previousSessionId,
          cwd: opts.cwd,
          mcpServers: [],
        });
      }
      opts.logger.info(
        { sessionId: previousSessionId, mode: hasResume ? "resume" : "load" },
        "session resumed",
      );
      return {
        agent: {
          process: proc,
          connection,
          sessionId: previousSessionId,
          capabilities: caps,
          getRecentStderr,
        },
        resumed: true,
      };
    } catch (err) {
      opts.logger.warn({ err, previousSessionId }, "resume failed, will start fresh");
    }
  }

  let sessionResult: acp.NewSessionResponse;
  try {
    sessionResult = await connection.newSession({ cwd: opts.cwd, mcpServers: [] });
  } catch (err) {
    throw new Error("Failed to create agent session after resume failure", { cause: err });
  }
  opts.logger.info({ sessionId: sessionResult.sessionId }, "fresh session created");

  return {
    agent: {
      process: proc,
      connection,
      sessionId: sessionResult.sessionId,
      capabilities: caps,
      getRecentStderr,
    },
    resumed: false,
  };
}

async function spawnAndInit(opts: SpawnAgentOptions): Promise<SpawnInternal> {
  const { command, args, cwd, env, client, logger } = opts;

  logger.info({ command, args }, "spawning agent");

  const proc = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: STDIO_PIPED,
    shell: process.platform === WIN32_PLATFORM,
  });

  const stderrBuffer: string[] = [];
  let stderrCarry = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrCarry += chunk.toString();
    const parts = stderrCarry.split("\n");
    stderrCarry = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line) continue;
      logger.debug({ stream: "stderr" }, line);
      stderrBuffer.push(line);
      if (stderrBuffer.length > STDERR_BUFFER_LINES) stderrBuffer.shift();
    }
  });

  proc.on("error", (err) => {
    logger.error({ err }, "agent process error");
  });
  proc.on("exit", (code, signal) => {
    if (code === 0 || code === null) {
      logger.info({ code, signal }, "agent process exited");
    } else {
      logger.error({ code, signal }, "agent process exited unexpectedly");
    }
  });

  const getRecentStderr = (): readonly string[] => [...stderrBuffer];

  // Non-null asserted: stdio: STDIO_PIPED guarantees pipe streams exist.
  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout);
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(() => client, stream);

  let initResult: acp.InitializeResponse;
  try {
    initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
  } catch (err) {
    const tail = getRecentStderr();
    const stderrSuffix = tail.length > 0 ? `\nstderr:\n${tail.join("\n")}` : "";
    throw new Error(
      `Failed to initialize agent (${command} ${args.join(" ")}). Is the agent installed?${stderrSuffix}`,
      { cause: err },
    );
  }

  if (initResult.authMethods && initResult.authMethods.length > 0) {
    const ids = initResult.authMethods.map((m: { id: string }) => m.id);
    logger.debug({ authMethods: ids }, "agent advertised auth methods (informational only)");
  }

  return { proc, connection, initResult, getRecentStderr };
}

export function killAgent(proc: ChildProcess): void {
  try {
    if (!proc.killed && proc.exitCode === null) proc.kill("SIGTERM");
  } catch {
    // already dead
  }
}
