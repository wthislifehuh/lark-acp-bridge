Important correction first: **ACP is not going away.** You're not moving off ACP — `lark-cli` and MCP aren't replacements for it. They live at a different layer. Let me untangle the three protocols, because they stack rather than compete.

## The three layers (they coexist)

- **ACP** — how the *bridge* talks to the *agent subprocess*. Bidirectional JSON-RPC over stdio. This is and stays the backbone: it carries the prompt in, and streams thoughts/messages/tool-calls/permission-requests back out. Unchanged.
- **MCP** — how the *agent* calls *tools*. The bridge hosts a local MCP server and hands its address to the agent inside the ACP `newSession` call. When the agent invokes a Lark tool, that shows up **inside the same ACP session** as a normal `tool_call` event. So MCP rides *within* ACP, it doesn't bypass it.
- **`lark-cli`** — just a binary the agent shells out to *using its own native shell tool*. That shell tool is itself surfaced over ACP as a `tool_call`. So `lark-cli` usage also flows through ACP.

Think of it as: ACP is the pipe between bridge and agent. MCP and `lark-cli` are two different ways the agent reaches *back* into Lark — and both surface as tool calls over that same ACP pipe. The reason there are two is what we covered last turn: `lark-cli` = broad/cheap/one-shot for shell-capable agents; MCP = interactive (ask-and-wait) + works for shell-less agents + keeps credentials in the bridge.

## End-to-end: what happens on one user message

Here's the full backend path, with the real components. Say a user types *"summarize today's messages in this group and ask me whether to post it."*

**1. Inbound event.** `LarkWsConnection` receives a `message_received` event over the persistent WebSocket (no public endpoint).

**2. Routing + gating.** `LarkBridge.routeMessage` runs. `AccessControl` checks the sender against the allowlist (private-by-default). If not allowed, it's silently dropped. Commands like `/cancel`, `/new`, `/status` are handled here directly.

**3. Interpret (inbound translation).** `larkMessageToPrompt` (interpreter) turns the Lark message into ACP `ContentBlock[]` — text, `@mentions` resolved to names, attachments become placeholder text (`[图片 message_id=…]`), never raw bytes. The identity module prepends a context block (`[上下文: 群聊 … 用户 张三 …]`) if the sender changed.

**4. Session acquisition.** `ChatRuntime.enqueue` grabs the per-chat runtime. First message in a chat pays spawn + ACP `initialize` + `session/new` (this is where `mcpServers: [larkServer]` would be passed); later messages reuse the warm process and session. Messages within a chat are FIFO-serialized.

**5. Prompt over ACP.** The bridge calls `connection.prompt(blocks)` over stdio. The agent starts reasoning.

**6. The agent streams back** — over ACP — a mix of:
- `agent_thought_chunk` / `agent_message_chunk` → `LarkAcpClient` appends to a structured timeline → debounced (300ms) `patchCard` via the presenter updates *one* Lark card.
- `tool_call` / `tool_call_update` → also rendered into the same card.

**7. Agent takes a Lark action (this is the MCP/lark-cli part).** To "summarize today's messages," the agent calls a tool:
   - **Via MCP**: it calls `lark.listChatHistory(chatId, …)`. The call goes agent → (MCP, local) → **the bridge's MCP server**, which uses its live Lark HTTP client to fetch messages and returns structured data. The bridge holds the token; the agent never sees it. This round-trip is a `tool_call` on the ACP stream, so it renders in the card too.
   - **Via `lark-cli`**: alternatively the agent runs `lark-cli im messages list …` through its shell tool; same visible result, but only if that agent has a shell.

**8. The interactive "ask me" step (MCP's unique capability).** The agent calls `lark.askChoice("Post this summary?", ["Yes","No"])`. The bridge's MCP server sends a Lark card with buttons and **blocks the tool call** on a pending-promise (same pattern as `pendingPermissions`). The user clicks → the click arrives back over the WebSocket → `LarkBridge.handleCardAction` (operator-bound, so only the asker's click counts) → the promise resolves → the tool call returns `"Yes"` to the agent. `lark-cli` fundamentally can't do this — a CLI process can't wait for a future Lark event.

**9. Permission cards (unchanged, orthogonal).** If a *write* tool is configured `alwaysAsk`, the agent's `requestPermission` (ACP) pops an authorization card before the tool runs. That's the bridge policing tool execution; step 8 is the *agent* asking the user a question. Different mechanisms.

**10. Finalize.** The agent's `prompt()` resolves with a `stopReason`. `LarkAcpClient.finalize` does a last card patch (header goes to ✅ complete / ⛔ cancelled / ❌ failed). If the card ever exceeds Lark's ~30KB limit, it falls back to a plain-text reply so the answer is never lost. `SessionStore` has the `chatId → sessionId` mapping persisted for resume after restart.

## The one-line mental model

```
Lark user ──WS──► LarkBridge ──ACP(stdio)──► agent subprocess
                     ▲  │                          │
                     │  └── interpreter/presenter  │ agent calls a tool:
                     │                             ▼
                     └───────── MCP server ◄──MCP(local)── lark tool
                        (bridge's live Lark client + WS callbacks)
```

So the suite is still an **ACP bridge**. Adding MCP just means the bridge starts *also* acting as a local tool provider to the agent — completing the loop so the agent can act *on* Lark, not just answer *into* it. Want me to sketch the actual MCP server module (starting with `listChatHistory` + `askChoice`) so you can see how the promise-bridge for step 8 wires into the existing `handleCardAction`?