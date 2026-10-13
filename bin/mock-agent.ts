#!/usr/bin/env node
/**
 * `lark-acp-mock` — minimal ACP agent that always returns the same scripted
 * turn. Useful for end-to-end testing the Lark <-> ACP bridge UI without
 * spending real model tokens.
 *
 * The scripted turn covers every surface the bridge is expected to render:
 *
 *   1. an `agent_thought_chunk` (thought) so the presenter exercises the
 *      thought timeline branch.
 *   2. a `tool_call` + `tool_call_update` pair (tool call) that completes
 *      without permission gating.
 *   3. a `requestPermission` call (permission gate) that blocks until the user
 *      picks an option in the Lark interrupt card.
 *   4. one or more `agent_message_chunk` payloads carrying a fully-formed
 *      markdown document — headings, lists, fenced code, tables, links —
 *      so `lark-markdown.ts` is hit on every block kind.
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const MOCK_TURN_DELAY_MS = 400;
const PROTOCOL_LOG_PREFIX = "[mock-agent]";

const SESSION_ID_BYTE_LEN = 16;
const HEX_RADIX = 16;
const HEX_PAD = 2;

const PERMISSION_OPTION_ALLOW = "allow";
const PERMISSION_OPTION_REJECT = "reject";

const TOOL_CALL_READ_ID = "mock_tool_read";
const TOOL_CALL_EDIT_ID = "mock_tool_edit";

const MOCK_THOUGHT = [
  "The user wants to see a full mock output, so I should emit, in order:",
  "1) a thought;",
  "2) a tool call that needs no permission;",
  "3) a tool call that does need permission;",
  "4) an answer exercising every Markdown element.",
].join("\n");

const MOCK_FILE_PATH = "/mock/project/README.md";
const MOCK_CONFIG_PATH = "/mock/project/config.json";

const MOCK_MARKDOWN_INTRO = "Sure — here is a fixed mock reply:\n\n";

const MOCK_MARKDOWN_BODY = `# Mock Agent sample answer

This is a **fixed-output** mock agent used to demo rendering on the Lark side. It triggers, in order:

- thought (\`agent_thought_chunk\`)
- tool call (\`tool_call\` / \`tool_call_update\`)
- permission gate (\`session/request_permission\`)
- Markdown rich-text answer (\`agent_message_chunk\`)

## Lists

1. Top-level item *italic*
2. Top-level item **bold**
   - Nested item \`inline code\`
   - Nested item ~~strikethrough~~
3. Link example: [ACP](https://agentcommunicationprotocol.dev)

## Code

\`\`\`ts
export function greet(name: string): string {
  return \`hello, \${name}\`;
}
\`\`\`

## Table

| Field | Meaning | Example |
| --- | --- | --- |
| sessionUpdate | Event type | agent_message_chunk |
| toolCallId | Tool call ID | mock_tool_read |
| status | Tool status | completed |

> This is a blockquote, used to demo blockquote rendering.

---

End of answer.`;

interface SessionState {
  pendingPrompt: AbortController | null;
}

class MockAgent implements acp.Agent {
  private readonly connection: acp.AgentSideConnection;
  private readonly sessions = new Map<string, SessionState>();

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection;
  }

  initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return Promise.resolve({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
      },
    });
  }

  newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomSessionId();
    this.sessions.set(sessionId, { pendingPrompt: null });
    return Promise.resolve({ sessionId });
  }

  authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return Promise.resolve({});
  }

  setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    return Promise.resolve({});
  }

  cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
    return Promise.resolve();
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    session.pendingPrompt?.abort();
    const controller = new AbortController();
    session.pendingPrompt = controller;

    try {
      await this.runScriptedTurn(params.sessionId, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw err;
    } finally {
      if (session.pendingPrompt === controller) {
        session.pendingPrompt = null;
      }
    }

    return { stopReason: "end_turn" };
  }

  private async runScriptedTurn(sessionId: string, signal: AbortSignal): Promise<void> {
    await this.emitThought(sessionId, MOCK_THOUGHT);
    await sleep(MOCK_TURN_DELAY_MS, signal);

    await this.emitToolCall(sessionId, {
      toolCallId: TOOL_CALL_READ_ID,
      title: "Reading mock README",
      kind: "read",
      path: MOCK_FILE_PATH,
      rawInput: { path: MOCK_FILE_PATH },
    });
    await sleep(MOCK_TURN_DELAY_MS, signal);
    await this.completeToolCall(sessionId, {
      toolCallId: TOOL_CALL_READ_ID,
      title: "Reading mock README",
      kind: "read",
      output: "# Mock Project\n\nThis is a mocked README content.",
    });

    await this.emitMessage(
      sessionId,
      "I read the project README first; next I need to modify a config file.\n\n",
    );
    await sleep(MOCK_TURN_DELAY_MS, signal);

    await this.emitToolCall(sessionId, {
      toolCallId: TOOL_CALL_EDIT_ID,
      title: "Modifying mock config",
      kind: "edit",
      path: MOCK_CONFIG_PATH,
      rawInput: { path: MOCK_CONFIG_PATH, content: '{"mocked": true}' },
    });

    const decision = await this.connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: TOOL_CALL_EDIT_ID,
        title: "Modifying mock config",
        kind: "edit",
        status: "pending",
        locations: [{ path: MOCK_CONFIG_PATH }],
        rawInput: { path: MOCK_CONFIG_PATH, content: '{"mocked": true}' },
      },
      options: [
        { kind: "allow_once", name: "Allow this edit", optionId: PERMISSION_OPTION_ALLOW },
        { kind: "reject_once", name: "Skip this edit", optionId: PERMISSION_OPTION_REJECT },
      ],
    });

    if (decision.outcome.outcome === "cancelled") {
      return;
    }

    if (decision.outcome.optionId === PERMISSION_OPTION_ALLOW) {
      await this.completeToolCall(sessionId, {
        toolCallId: TOOL_CALL_EDIT_ID,
        title: "Modifying mock config",
        kind: "edit",
        output: '{"mocked": true, "applied": true}',
      });
      await sleep(MOCK_TURN_DELAY_MS, signal);
      await this.emitMessage(sessionId, MOCK_MARKDOWN_INTRO);
      await this.emitMessage(sessionId, MOCK_MARKDOWN_BODY);
      return;
    }

    await this.failToolCall(sessionId, {
      toolCallId: TOOL_CALL_EDIT_ID,
      title: "Modifying mock config",
      kind: "edit",
    });
    await sleep(MOCK_TURN_DELAY_MS, signal);
    await this.emitMessage(
      sessionId,
      "OK, the edit was skipped. Send another message to trigger the mock turn again.",
    );
  }

  private async emitThought(sessionId: string, text: string): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      },
    });
  }

  private async emitMessage(sessionId: string, text: string): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  private async emitToolCall(
    sessionId: string,
    args: {
      toolCallId: string;
      title: string;
      kind: acp.ToolKind;
      path: string;
      rawInput: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: args.toolCallId,
        title: args.title,
        kind: args.kind,
        status: "pending",
        locations: [{ path: args.path }],
        rawInput: args.rawInput,
      },
    });
  }

  private async completeToolCall(
    sessionId: string,
    args: { toolCallId: string; title: string; kind: acp.ToolKind; output: string },
  ): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: args.toolCallId,
        title: args.title,
        kind: args.kind,
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: args.output },
          },
        ],
        rawOutput: { content: args.output },
      },
    });
  }

  private async failToolCall(
    sessionId: string,
    args: { toolCallId: string; title: string; kind: acp.ToolKind },
  ): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: args.toolCallId,
        title: args.title,
        kind: args.kind,
        status: "failed",
        rawOutput: { error: "rejected by user" },
      },
    });
  }
}

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTE_LEN));
  return Array.from(bytes, (b) => b.toString(HEX_RADIX).padStart(HEX_PAD, "0")).join("");
}

/**
 * Resolve after `ms` milliseconds, or reject early when `signal` aborts.
 *
 * @throws when `signal` aborts before the timer fires.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function main(): void {
  // ACP speaks over stdio: the client writes to the agent's stdin and the
  // agent writes its responses to stdout.
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);
  new acp.AgentSideConnection((conn) => new MockAgent(conn), stream);
  process.stderr.write(`${PROTOCOL_LOG_PREFIX} ready\n`);
}

main();
