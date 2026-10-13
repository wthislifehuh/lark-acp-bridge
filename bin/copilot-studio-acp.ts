#!/usr/bin/env node
/**
 * `lark-acp-copilot-studio` — an ACP agent adapter for **Microsoft Copilot
 * Studio** agents (https://copilotstudio.microsoft.com/).
 *
 * Copilot Studio has no ACP-speaking CLI (verified 2026-07: nothing on the
 * ACP registry, GitHub, or npm — see docs/microsoft-copilot-plan.md). This
 * adapter translates between ACP (JSON-RPC over stdio, spoken to the bridge)
 * and Microsoft's "Direct to Engine" protocol (SSE over HTTPS, spoken through
 * the official `@microsoft/agents-copilotstudio-client`).
 *
 * Design (see README "接入 Microsoft Copilot Studio"):
 *
 * - Auth is Entra ID. A one-time `lark-acp-copilot-studio login` runs the
 *   MSAL device-code flow and persists the token cache; at bridge runtime
 *   tokens are refreshed silently. `client-secret` (app-only) and
 *   `static-token` modes are also supported via env.
 * - Conversation state lives on Microsoft's side, so an ACP session maps to a
 *   Copilot Studio `conversationId`; `session/load` restores the id from disk
 *   and the conversation continues server-side (no transcript replay).
 * - Activities stream back over SSE. Generative answers arrive as `typing`
 *   activities carrying cumulative text (accumulated by the SDK) followed by
 *   a final `message`; the renderer emits only unseen suffixes so the Lark
 *   card can append chunks in order.
 * - `eventsource-client` (inside the SDK) ignores HTTP error statuses and
 *   would reconnect-loop on a 401, so a scoped fetch trap converts upstream
 *   failures into a clean stream end plus a recorded failure that is
 *   re-thrown with a useful message ("Authentication required: ..." for
 *   401/403 — the prefix the bridge recognizes).
 *
 * Inherent limitations (API surface, not bugs): no per-tool permission cards
 * and no thought/tool timeline — Copilot Studio's conversational API exposes
 * neither.
 *
 * Pure helpers live in `./copilot-studio-acp-core.ts`; this file owns the ACP
 * connection, auth, and the Copilot Studio client lifecycle.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Activity } from "@microsoft/agents-activity";
import {
  AgentType,
  ConnectionSettings,
  CopilotStudioClient,
  PowerPlatformCloud,
  ScopeHelper,
  type StartRequest,
} from "@microsoft/agents-copilotstudio-client";
import {
  ActivityRenderer,
  DEFAULT_POWER_PLATFORM_SCOPE,
  describeUpstreamFailure,
  loadConfig,
  validateConfig,
  type CopilotStudioAdapterConfig,
  type UpstreamHttpFailure,
} from "./copilot-studio-acp-core.js";
import {
  CONVERSATION_SESSION_FILE_VERSION,
  parseConversationSessionFile,
  sessionFilePath,
} from "./session-file.js";
import {
  acquireTokenSilently,
  createClientSecretTokenSource,
  loginWithDeviceCode,
  type MsalAuthOptions,
} from "./msal-auth.js";
import { flattenPrompt } from "./prompt-text.js";

const PROTOCOL_LOG_PREFIX = "[copilot-studio-acp]";
const AGENT_NAME = "lark-acp-copilot-studio";
const AGENT_VERSION = "0.1.0";
const LOGIN_COMMAND = "lark-acp-copilot-studio login";
const MSAL_CACHE_FILE = "msal-cache.json";

const EMPTY_OUTPUT_NOTE = "_(Copilot Studio returned no content)_";
const EMPTY_PROMPT_NOTE = "_(empty message — Copilot Studio was not called)_";

/** How much of an upstream error body to keep for the failure card. */
const FAILURE_BODY_TAIL_CHARS = 400;

function assertNever(x: never): never {
  throw new Error(`unexpected: ${String(x)}`);
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferred(): Deferred {
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolveFn?.();
    },
  };
}

interface SessionState {
  conversationId: string | null;
  cancelled: boolean;
  cancelSignal: Deferred;
}

interface ConsumeResult {
  readonly cancelled: boolean;
  readonly endOfConversation: boolean;
  readonly conversationId: string | null;
}

/** The turn exceeded `COPILOT_STUDIO_TURN_TIMEOUT_MS`. */
class TurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Copilot Studio response timed out (${String(timeoutMs)} ms). If this persists, check that the agent is published, the token permissions, and network connectivity`,
    );
    this.name = "TurnTimeoutError";
  }
}

type ConnectionOptionsArg = NonNullable<ConstructorParameters<typeof ConnectionSettings>[0]>;

/**
 * Match a raw env string against a TS string enum (case-insensitive) and
 * return the enum value.
 *
 * @throws when the value is not a member of the enum.
 */
function parseEnumValue<T extends Record<string, string>>(
  enumObj: T,
  raw: string,
  envName: string,
): T[keyof T] {
  for (const [key, value] of Object.entries(enumObj)) {
    if (key.toLowerCase() === raw.toLowerCase() || value.toLowerCase() === raw.toLowerCase()) {
      // Guarded narrowing: `value` was read off the enum object itself.
      return value as T[keyof T];
    }
  }
  throw new Error(`${envName} must be one of ${Object.keys(enumObj).join(" / ")}, got "${raw}"`);
}

function buildConnectionSettings(config: CopilotStudioAdapterConfig): ConnectionSettings {
  const options: ConnectionOptionsArg = {};
  if (config.directConnectUrl !== null) options.directConnectUrl = config.directConnectUrl;
  if (config.environmentId !== null) options.environmentId = config.environmentId;
  if (config.schemaName !== null) options.schemaName = config.schemaName;
  if (config.cloud !== null) {
    options.cloud = parseEnumValue(PowerPlatformCloud, config.cloud, "COPILOT_STUDIO_CLOUD");
  }
  if (config.agentType !== null) {
    options.copilotAgentType = parseEnumValue(
      AgentType,
      config.agentType,
      "COPILOT_STUDIO_AGENT_TYPE",
    );
  }
  return new ConnectionSettings(options);
}

function resolveScopes(config: CopilotStudioAdapterConfig, settings: ConnectionSettings): string[] {
  if (config.scopes !== null) return [...config.scopes];
  try {
    return [ScopeHelper.getScopeFromSettings(settings)];
  } catch {
    // Scope derivation needs a recognizable Power Platform host; fall back to
    // the public-cloud audience (correct for the overwhelming majority).
    return [DEFAULT_POWER_PLATFORM_SCOPE];
  }
}

function buildMsalOptions(
  config: CopilotStudioAdapterConfig,
  scopes: readonly string[],
): MsalAuthOptions {
  if (config.tenantId === null || config.appClientId === null) {
    throw new Error("missing COPILOT_STUDIO_TENANT_ID / COPILOT_STUDIO_APP_CLIENT_ID");
  }
  return {
    clientId: config.appClientId,
    tenantId: config.tenantId,
    scopes,
    cacheFilePath: path.join(config.dataDir, MSAL_CACHE_FILE),
    ...(config.authorityBase !== null ? { authorityBase: config.authorityBase } : {}),
  };
}

function createTokenSource(
  config: CopilotStudioAdapterConfig,
  settings: ConnectionSettings,
): () => Promise<string> {
  const mode = config.authMode;
  switch (mode) {
    case "static-token": {
      const token = config.staticToken;
      if (token === null)
        throw new Error("authMode=static-token requires COPILOT_STUDIO_STATIC_TOKEN");
      return () => Promise.resolve(token);
    }
    case "client-secret": {
      const secret = config.clientSecret;
      if (secret === null)
        throw new Error("authMode=client-secret requires COPILOT_STUDIO_CLIENT_SECRET");
      const options = buildMsalOptions(config, resolveScopes(config, settings));
      return createClientSecretTokenSource(options, secret);
    }
    case "device-code": {
      const options = buildMsalOptions(config, resolveScopes(config, settings));
      return () => acquireTokenSilently(options, LOGIN_COMMAND);
    }
    default:
      return assertNever(mode);
  }
}

/**
 * Wrap `globalThis.fetch` so upstream Copilot Studio error responses end the
 * SSE stream cleanly (instead of reconnect-looping inside the SDK) and get
 * recorded for post-turn classification. Non-matching requests pass through.
 */
function installUpstreamFailureTrap(
  matchesUpstream: (url: string) => boolean,
  record: (failure: UpstreamHttpFailure) => void,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!matchesUpstream(url) || response.ok) return response;
    let bodyTail = "";
    try {
      bodyTail = (await response.text()).slice(0, FAILURE_BODY_TAIL_CHARS);
    } catch {
      // Body unavailable — the status code alone still classifies the error.
    }
    record({ status: response.status, url, bodyTail });
    return new Response("event: end\ndata: {}\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

/**
 * @throws when the fetch trap recorded an upstream HTTP failure for this turn.
 */
function throwOnUpstreamFailure(failures: readonly UpstreamHttpFailure[]): void {
  const failure = failures[0];
  if (!failure) return;
  throw new Error(describeUpstreamFailure(failure, LOGIN_COMMAND));
}

class CopilotStudioAgent implements acp.Agent {
  private readonly connection: acp.AgentSideConnection;
  private readonly config: CopilotStudioAdapterConfig;
  private readonly settings: ConnectionSettings;
  private readonly getToken: () => Promise<string>;
  private readonly sessions = new Map<string, SessionState>();
  /**
   * Per-turn sink for upstream HTTP failures. The fetch trap (installed once,
   * globally) records into whichever turn's array is active in the current
   * async context, so concurrent turns — the adapter's `sessions` Map allows
   * more than one — never clobber each other's recorded 401/403.
   */
  private readonly failureStore = new AsyncLocalStorage<UpstreamHttpFailure[]>();
  /** Serialises outgoing session updates so streamed chunks stay ordered. */
  private emitChain: Promise<void> = Promise.resolve();

  constructor(connection: acp.AgentSideConnection, config: CopilotStudioAdapterConfig) {
    this.connection = connection;
    this.config = config;
    this.settings = buildConnectionSettings(config);
    this.getToken = createTokenSource(config, this.settings);

    const upstreamHost = this.resolveUpstreamHostMatcher();
    installUpstreamFailureTrap(upstreamHost, (failure) => {
      this.failureStore.getStore()?.push(failure);
      process.stderr.write(
        `${PROTOCOL_LOG_PREFIX} upstream HTTP ${String(failure.status)} from ${failure.url}\n`,
      );
    });
  }

  private resolveUpstreamHostMatcher(): (url: string) => boolean {
    if (this.config.directConnectUrl !== null) {
      try {
        const host = new URL(this.config.directConnectUrl).host;
        return (url) => {
          try {
            return new URL(url).host === host;
          } catch {
            return false;
          }
        };
      } catch {
        // Invalid URL is rejected later by the SDK with its own error.
        return () => false;
      }
    }
    return (url) => {
      try {
        return new URL(url).host.endsWith(".powerplatform.com");
      } catch {
        return false;
      }
    };
  }

  initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return Promise.resolve({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
    });
  }

  authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return Promise.resolve({});
  }

  newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      conversationId: null,
      cancelled: false,
      cancelSignal: createDeferred(),
    });
    return Promise.resolve({ sessionId });
  }

  /**
   * Restore a session persisted by a previous run. The transcript itself
   * lives on Microsoft's side — only the conversation id is restored.
   *
   * @throws when no valid session file exists for `sessionId`; the bridge
   *         then falls back to {@link newSession}.
   */
  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const file = sessionFilePath(this.config.dataDir, params.sessionId);
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, "utf8");
    } catch (err) {
      throw new Error(`No stored conversation for session ${params.sessionId}`, { cause: err });
    }
    const stored = parseConversationSessionFile(raw);
    this.sessions.set(params.sessionId, {
      conversationId: stored.conversationId,
      cancelled: false,
      cancelSignal: createDeferred(),
    });
    return {};
  }

  setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    return Promise.resolve({});
  }

  cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return Promise.resolve();
    session.cancelled = true;
    session.cancelSignal.resolve();
    return Promise.resolve();
  }

  /**
   * Run one turn: lazily start the server-side conversation, send the user
   * message, and stream the response activities back as message chunks.
   *
   * @throws {AuthRequiredError} when silent token acquisition fails.
   * @throws {TurnTimeoutError} when the turn exceeds the configured timeout.
   * @throws when Copilot Studio rejects the request (401/403/404/429/...).
   */
  prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    // Run the turn inside a fresh failure sink so the global fetch trap records
    // this turn's upstream errors into an array only this turn reads.
    const failures: UpstreamHttpFailure[] = [];
    return this.failureStore.run(failures, () => this.runPrompt(params, failures));
  }

  private async runPrompt(
    params: acp.PromptRequest,
    failures: readonly UpstreamHttpFailure[],
  ): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    session.cancelled = false;
    session.cancelSignal = createDeferred();

    const userText = flattenPrompt(params.prompt);
    if (!userText) {
      this.emit(params.sessionId, EMPTY_PROMPT_NOTE);
      await this.emitChain;
      return { stopReason: "end_turn" };
    }

    const token = await this.getToken();
    const client = new CopilotStudioClient(this.settings, token);
    const renderer = new ActivityRenderer();
    const deadline = Date.now() + this.config.turnTimeoutMs;

    // Lazily start the server-side conversation; greeting activities (if the
    // agent has a greeting topic) stream into the same card as the answer.
    if (session.conversationId === null) {
      const startRequest: StartRequest = {
        emitStartConversationEvent: this.config.emitStartEvent,
        ...(this.config.locale !== null ? { locale: this.config.locale } : {}),
      };
      const started = await this.consume(
        params.sessionId,
        session,
        client.startConversationStreaming(startRequest),
        renderer,
        deadline,
      );
      await this.emitChain;
      throwOnUpstreamFailure(failures);
      if (started.cancelled) return { stopReason: "cancelled" };
      session.conversationId = started.conversationId;
    }

    const activityInput: Record<string, unknown> = { type: "message", text: userText };
    if (session.conversationId !== null) {
      activityInput.conversation = { id: session.conversationId };
    }
    if (this.config.locale !== null) activityInput.locale = this.config.locale;
    const activity = Activity.fromObject(activityInput);

    // With a known conversation id use the explicit-id call; otherwise (start
    // yielded no activities, e.g. greeting disabled) fall back to the client's
    // internally captured id from the `x-ms-conversationid` response header.
    const generator =
      session.conversationId !== null
        ? client.executeStreaming(activity, session.conversationId)
        : client.sendActivityStreaming(activity);

    const result = await this.consume(params.sessionId, session, generator, renderer, deadline);

    // Flush in-flight chunks before finalising the card.
    await this.emitChain;
    throwOnUpstreamFailure(failures);

    if (result.cancelled) return { stopReason: "cancelled" };

    if (result.conversationId !== null) session.conversationId = result.conversationId;
    if (result.endOfConversation) session.conversationId = null;

    if (!renderer.hasOutput) {
      this.emit(params.sessionId, EMPTY_OUTPUT_NOTE);
      await this.emitChain;
    }

    await this.persist(params.sessionId, session);
    return { stopReason: "end_turn" };
  }

  /**
   * Drain an activity generator, emitting rendered chunks. Each step races
   * the generator against the session's cancel signal and the turn deadline.
   *
   * @throws {TurnTimeoutError} on deadline; upstream stream errors propagate.
   */
  private async consume(
    sessionId: string,
    session: SessionState,
    generator: AsyncGenerator<Activity>,
    renderer: ActivityRenderer,
    deadline: number,
  ): Promise<ConsumeResult> {
    let endOfConversation = false;
    let conversationId: string | null = null;

    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        this.abandon(generator);
        throw new TurnTimeoutError(this.config.turnTimeoutMs);
      }

      const nextPromise = generator.next();
      const step = await raceStep(nextPromise, session.cancelSignal.promise, remainingMs);

      if (step === "cancelled" || step === "timeout") {
        // The pending next() may settle (or reject) later — silence it and
        // ask the generator to close its SSE connection.
        nextPromise.catch(() => {
          /* superseded by cancel/timeout */
        });
        this.abandon(generator);
        if (step === "timeout") throw new TurnTimeoutError(this.config.turnTimeoutMs);
        return { cancelled: true, endOfConversation, conversationId };
      }

      if (step.done) break;

      const activityConversationId = step.value.conversation?.id;
      if (activityConversationId) conversationId = activityConversationId;

      const rendered = renderer.render(step.value);
      if (rendered.chunk) this.emit(sessionId, rendered.chunk);
      if (rendered.endOfConversation) endOfConversation = true;
    }

    return { cancelled: session.cancelled, endOfConversation, conversationId };
  }

  private abandon(generator: AsyncGenerator<Activity>): void {
    // Best effort: triggers the generator's finally (which closes the SSE
    // connection). May itself never settle if the stream is wedged.
    void Promise.resolve(generator.return(undefined)).catch(() => {
      /* generator already dead */
    });
  }

  /** Queue a text chunk as an `agent_message_chunk`, preserving order. */
  private emit(sessionId: string, text: string): void {
    this.emitChain = this.emitChain
      .then(() =>
        this.connection.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        }),
      )
      .catch((err: unknown) => {
        process.stderr.write(`${PROTOCOL_LOG_PREFIX} sessionUpdate failed: ${String(err)}\n`);
      });
  }

  private async persist(sessionId: string, session: SessionState): Promise<void> {
    const file = sessionFilePath(this.config.dataDir, sessionId);
    const payload = {
      version: CONVERSATION_SESSION_FILE_VERSION,
      sessionId,
      conversationId: session.conversationId,
      updatedAt: Date.now(),
    };
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(payload), "utf8");
      await fs.promises.rename(tmp, file);
    } catch (err) {
      // Persistence is a best-effort convenience (enables resume-after-restart);
      // never fail a turn over it.
      process.stderr.write(`${PROTOCOL_LOG_PREFIX} session persist failed: ${String(err)}\n`);
    }
  }
}

type StepOutcome<T> = IteratorResult<T> | "cancelled" | "timeout";

async function raceStep<T>(
  next: Promise<IteratorResult<T>>,
  cancelPromise: Promise<void>,
  timeoutMs: number,
): Promise<StepOutcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, timeoutMs);
  });
  try {
    return await Promise.race([next, cancelPromise.then(() => "cancelled" as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runLogin(config: CopilotStudioAdapterConfig): Promise<void> {
  if (config.authMode !== "device-code") {
    console.log(`authMode=${config.authMode} — device-code login is not needed.`);
    return;
  }
  let settings: ConnectionSettings;
  try {
    settings = buildConnectionSettings(config);
  } catch {
    settings = new ConnectionSettings({});
  }
  const options = buildMsalOptions(config, resolveScopes(config, settings));
  const username = await loginWithDeviceCode(options, (instruction) => {
    console.log(instruction);
  });
  console.log(`Signed in as ${username} (token cache written to ${options.cacheFilePath})`);
}

async function runLogout(config: CopilotStudioAdapterConfig): Promise<void> {
  const cacheFile = path.join(config.dataDir, MSAL_CACHE_FILE);
  await fs.promises.rm(cacheFile, { force: true });
  console.log(`Deleted token cache: ${cacheFile}`);
}

function serve(config: CopilotStudioAdapterConfig): void {
  const problems = validateConfig(config);
  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`${PROTOCOL_LOG_PREFIX} config error: ${problem}\n`);
    }
    process.exit(1);
  }

  // ACP over stdio: the bridge writes to our stdin, we answer on stdout.
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);
  new acp.AgentSideConnection((conn) => new CopilotStudioAgent(conn, config), stream);
  process.stderr.write(
    `${PROTOCOL_LOG_PREFIX} ready (authMode=${config.authMode}, target=${
      config.directConnectUrl ?? `${config.environmentId ?? "?"}/${config.schemaName ?? "?"}`
    })\n`,
  );
}

function main(): void {
  const config = loadConfig(process.env);
  const subcommand = process.argv[2];

  if (subcommand === "login") {
    runLogin(config).catch((err: unknown) => {
      console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
    return;
  }
  if (subcommand === "logout") {
    runLogout(config).catch((err: unknown) => {
      console.error(`Logout failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
    return;
  }
  serve(config);
}

main();
