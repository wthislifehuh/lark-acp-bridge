# Lark MCP Tool Server — design

> Status: design + phased implementation. Gives the agent a **reverse channel**
> into Lark. Today the bridge is one-directional (Lark message → ACP prompt →
> card out); this adds a curated set of **MCP tools** the agent can call to act
> _on_ Lark — ask the user a question and wait for the answer, download an
> attachment, list recent messages, send a message to a chat.
>
> Companion to `docs/architecture-and-scaling-plan.md` (§ "飞书工具注入" in
> `PLAN.md` is the original sketch this refines) and
> `docs/acp-mcp-cli-explanation.md` (how ACP / MCP / `lark-cli` relate).

---

## 0. TL;DR

1. The bridge hosts **one in-process MCP server** over **Streamable HTTP** bound
   to `127.0.0.1` on an ephemeral port. No public endpoint — same NAT-friendly
   posture as the rest of the bridge.
2. It's injected per chat via ACP `newSession({ mcpServers: [...] })` — the
   resolved list `agent-process.ts` now threads into
   `newSession`/`loadSession`/`resumeSession` (previously a hardcoded empty
   `[]`). Injection is **gated on `agentCapabilities.mcpCapabilities.http`** (via
   `resolveMcpServers`); an agent that can't do HTTP MCP simply runs without Lark
   tools (no regression).
3. Each chat gets a **distinct URL path carrying an unguessable token**
   (`/mcp/<token>`). A tool call therefore self-identifies its chat with zero
   correlation logic — the handler binds straight to that chat's context
   (`chatId`, live `LarkHttpClient`, `LarkPresenter`, and the interactive
   promise-bridge).
4. **Interactive tools reuse the existing card-action promise-bridge** — the
   exact pattern `LarkAcpClient` already uses for permission cards
   (`pendingPermissions` resolved by `handleCardAction`). `ask_choice` sends a
   card and blocks the tool call until the bound user clicks; the click arrives
   on the WebSocket and resolves the promise.
5. **The bridge holds the token** and makes every API call itself — the agent
   subprocess never sees Lark credentials (unlike the opt-in `lark-cli`
   `injectCredentials`). Every call flows through one place, so allow/deny lists
   and rate limits are enforced uniformly.
6. Off by default. Opt in with `--lark-tools` / `tools.enabled`. Write-capable
   tools stay behind the existing permission cards.

---

## 1. Why in-process HTTP (and not stdio)

ACP's `McpServer` has three transports (verified in the SDK schema,
`types.gen.d.ts`): `McpServerStdio` (`command`/`args`/`env`), `McpServerHttp`
(`url`/`headers`), `McpServerSse` (`url`/`headers`). Only HTTP/SSE are gated by
a capability (`mcpCapabilities.http` / `.sse`); stdio is always allowed.

|                                                     | stdio                                                                  | **http (chosen)**                       |
| --------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| Who runs the server                                 | the **agent** spawns it as a subprocess                                | the **bridge** runs it in-process       |
| Access to live Lark connection                      | none — separate process; needs a second `LarkHttpClient` + credentials | direct — reuses `this.http`             |
| Interactive `ask_choice` (wait for a WS card click) | impossible without a back-channel IPC to the bridge                    | trivial — resolves an in-memory promise |
| Credentials exposure                                | server process needs app secret                                        | none — bridge holds it                  |
| Extra hop                                           | pipe                                                                   | one `127.0.0.1` request (sub-ms)        |

The whole value of the reverse channel is the _interactive_ + _shell-less-agent_
tools that `lark-cli` structurally can't do (see `acp-mcp-cli-explanation.md`).
Those require the tool handler to live **in the bridge process** next to the
WebSocket and the pending-promise map. That forces HTTP (or SSE). stdio would
mean spawning a second process, duplicating the Lark client + credentials, and
building an IPC channel back to the bridge just to await a card click — heavier
and less secure for no benefit.

**Fallback / compatibility.** If an agent advertises `mcpCapabilities.http =
false` we don't inject the server (log once, continue). A future stdio-proxy
shim (a tiny `lark-acp-mcp` bin that relays to the bridge over a local socket)
can cover stdio-only agents, but it's explicitly out of scope for v1.

---

## 2. Architecture

```
                         LarkBridge process
  ┌───────────────────────────────────────────────────────────────┐
  │                                                                 │
  │  LarkWsConnection ──► routeMessage ──► ChatRuntime(chatId) ──ACP─┼─► agent
  │        ▲                                   │  (mcpServers:        │   subprocess
  │        │ card.action                       │   [{http, /mcp/tok}])│      │
  │        │                                   ▼                      │      │ MCP tool call
  │  handleCardAction ──────────► ToolContext(chatId) ◄──────────────┼──────┘  (127.0.0.1)
  │        │  resolves pending    (http, presenter, askChoice bridge)│
  │        ▼                                   ▲                      │
  │  LarkToolServer  ── token registry ────────┘                     │
  │  (StreamableHTTP on 127.0.0.1:port)                              │
  └───────────────────────────────────────────────────────────────┘
```

- **`LarkToolServer`** — owns one Node HTTP server on `127.0.0.1`, a
  `Map<token, ToolContext>`, and the MCP tool definitions. `register(ctx) →
{ url, token }`, `unregister(token)`, `start()`, `stop()`.
- **`ToolContext`** — per-chat handle a tool executes against: `chatId`, the
  shared `LarkHttpClient`, the `LarkPresenter`, and an `askUser()` promise-bridge
  (registered/resolved through the bridge's card-action path). One per
  `ChatRuntime`, registered in `acquireRuntime`, unregistered on
  `shutdown`/evict.
- **Injection** — `agent-process.ts` gains an optional `mcpServers` arg passed
  into `newSession` / `loadSession` / `resumeSession`. The bridge builds the
  per-chat `McpServerHttp` config and hands it to the `ChatRuntime`, which
  passes it through to spawn.

### Why a per-chat token instead of one shared endpoint

Injection already happens per chat (each `ChatRuntime` calls `newSession`
once). Handing each chat a unique `/mcp/<token>` URL means a tool call is
**self-routing**: the URL _is_ the chat identity. No session-id correlation, no
guessing which chat a call belongs to, and it doubles as an authorization
boundary (a leaked token only reaches one chat's read-scoped tools, and the
loopback bind keeps it off the network). Tokens are `crypto.randomUUID()` (or
32 random bytes hex), minted per runtime, dropped on teardown.

---

## 3. Tool catalog

Curated and small on purpose — a bloated tool list slows the agent's planning
and bloats every prompt's tool schema. v1 ships four tools spanning the three
capability classes; more are added only when a concrete need appears.

| Tool                         | Class            | Blocking?                | Notes                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lark_ask_choice`            | interactive      | **yes** — awaits a click | question + 2–N options → card with buttons; returns the chosen option id. Bound to the requesting user (only their click counts, reusing the §4.1 operator binding).                                                                                                                                                |
| `lark_ask_text`              | interactive      | **yes** — awaits a reply | prompt the user for a free-text reply; the bridge captures that user's next message in the chat as the return value.                                                                                                                                                                                                |
| `lark_download_message_file` | resource         | no                       | fetch bytes for a `message_id` + `file_key` the user referenced; returns an MCP resource / base64 blob. Backed by `LarkHttpClient.downloadMessageResource(messageId, fileKey, type)` — the `image`/`file` generalization of `downloadMessageImage`, which has already landed; the MCP tool wrapper is what remains. |
| `lark_send_message`          | outbound (write) | no                       | send text/markdown to a chat. **Write** → gated behind a permission card unless `alwaysAllow`. Defaults to the current chat; other chats require explicit allow.                                                                                                                                                    |

Deliberately **not** in v1 (documented for scope): `list_chat_history` (needs
`im:message:readonly` + pagination), `send_card` (arbitrary card JSON — schema
risk), `list_chat_members` / `get_user_info` (metadata, low value first),
`upload_image`. Each is a clean follow-on once the framework exists.

### The interactive contract (`ask_choice` / `ask_text`)

This is the piece `lark-cli` cannot do. It reuses the existing promise-bridge
verbatim in shape:

```
agent calls lark_ask_choice(question, options)
  → tool handler:  ctx.askChoice(question, options)
      → mint askId; store { resolve, timer } in a pending map
      → presenter.sendCardToChat(chatId, choiceCard(askId, options, boundUser))
      → await the promise (with a timeout, same default as permission cards)
user taps a button
  → WS card.action → LarkBridge.handleCardAction
      → payload has { ask: askId, opt } → route to the chat's ToolContext
      → operator check (only the bound user) → pending.resolve(opt)
  → tool handler returns { chosen: opt } to the agent over MCP
```

`ask_text` is the same but resolved by the chat's **next inbound message** from
the bound user (captured in `routeMessage` before it becomes a prompt), not a
card click. Both have a timeout so a walked-away user can't park the agent
forever (mirrors `permissionTimeoutMs`).

---

## 4. Security & correctness

- **Loopback only.** Server binds `127.0.0.1` on an ephemeral port; the URL is
  never advertised anywhere but the agent's own session config.
- **Per-chat token.** A tool call can only touch the chat its token maps to.
  Unknown/expired token → 404. Tokens die with the runtime.
- **Credentials stay in the bridge.** The agent never receives the app secret;
  contrast the opt-in `lark-cli` `injectCredentials`.
- **Writes stay gated.** `lark_send_message` (and any future write tool) routes
  through the existing permission-card flow, honoring `alwaysAsk` /
  `alwaysAllow` / `alwaysDeny`. Read-only tools may run without a card.
- **Interactive clicks are operator-bound.** `ask_choice` reuses the §4.1
  operator-binding check so only the asking user can answer — no group member
  can hijack another user's prompt.
- **Prompt-injection posture.** Because ingested Lark content can carry
  instructions, write tools are never blanket-allowed for an assistant that
  reads external text (plan §4.3). The default keeps `lark_send_message` behind a
  card.
- **Rate limiting.** A small per-context token-bucket in front of Lark API
  calls protects against a runaway agent tripping Lark's API risk control;
  shared with the existing HTTP client's concerns.

---

## 5. Performance & "stays lightweight"

Explicit non-goals: don't make the hot path (a normal text turn with no tool
calls) any heavier, and don't bloat the tool schema.

- **Zero cost when unused.** The server is created only when `tools.enabled`
  _and_ the agent supports HTTP MCP. A turn with no tool call never touches it.
- **One server, N chats.** A single HTTP listener + a `Map` lookup per call —
  not a server per chat.
- **Lazy start.** The listener starts on the first chat that needs it, and stops
  when the bridge stops.
- **Small catalog.** Four tools keep the per-session tool schema tiny, so the
  agent's planning context barely grows.
- **Reuse, don't duplicate.** Same `LarkHttpClient` (with its name caches), same
  presenter, same promise-bridge, same card builders — no parallel stack.
- **Bounded interactivity.** Every blocking tool has a timeout and is cleaned up
  on cancel/shutdown, so tools can never leak a pending promise or a live timer.

---

## 6. Public API / config surface

- New module `src/lark-tools/` with an `index.ts` façade. Exports:
  `LarkToolServer`, `LarkToolServerOptions`, `ToolContext`, tool-name constants,
  and the `LarkToolsOptions` config type.
- `LarkBridgeOptions` gains an optional `tools?: LarkToolsOptions`
  (`{ enabled, allowSendMessage?, askTimeoutMs? }`). Omitted → today's behavior
  exactly.
- CLI: `--lark-tools` flag + `tools` block in `config.json`
  (`tools.enabled` / `tools.allowSendMessage`).
- `agent-process.ts`: `SpawnAgentOptions.mcpServers?: acp.McpServer[]`, threaded
  into `newSession`/`loadSession`/`resumeSession` (replacing the hardcoded
  `[]`).

---

## 7. Testing

- **Unit** (`src/lark-tools/*.test.ts`): token registry register/unregister/404;
  each tool handler against a fake `LarkHttpClient` + fake presenter; the
  `askChoice` promise-bridge (resolve on matching click, reject on non-operator,
  timeout path); rate-limit bucket.
- **E2E** (`tests/lark-mcp-tools.test.ts`): drive the real in-process server over
  a real MCP HTTP client — `initialize`, `tools/list` returns the catalog, a
  read tool round-trips, and `ask_choice` resolves when a simulated card action
  is fed to `handleCardAction`.
- Acceptance: hot path unchanged when disabled; injection skipped when
  `mcpCapabilities.http` is false; write tool blocked without a permission
  approval.

> **Status — unit suite landed** (`src/lark-tools/lark-tool-server.test.ts`).
> Covers the `LarkToolServer` registry (`register` returns a loopback
> `http://127.0.0.1:<port>/mcp/<token>` config and is idempotent per chat;
> `register` before `start()` throws; `unregister` disposes the context;
> `resolveAsk` routes to the chat and reports `orphan` for an unknown chat) and
> the `ToolContext.askChoice` operator-binding promise-bridge against a fake
> `LarkHttpClient` (resolve on the originating operator's click, `forbidden` +
> still-pending on a non-operator click, a privileged user may answer, `orphan`
> for an unknown ask id, `AskTimeoutError` on timeout and on `dispose`). Still
> outstanding: per-tool-handler coverage of `registerLarkTools` against a fake
> client, the HTTP-level 404 path for an unknown/expired token, and the §7 E2E
> suite. (The rate-limit bucket in §4/§5 is not yet implemented, so it has no
> test.)

---

## 8. Phased implementation

1. **Foundation — shipped.** `src/lark-tools/` — `LarkToolServer`
   (StreamableHTTP + per-chat token registry), `ToolContext`, and two tools
   (`lark_ask_choice` interactive, `lark_download_message_file` read).
   `mcpServers` threaded through `agent-process.ts`, gated on
   `agentCapabilities.mcpCapabilities.http`; the bridge constructs the server
   (`tools.enabled`), registers/unregisters a chat's context alongside its
   `ChatRuntime`, binds the current operator on every inbound prompt, and
   routes ask-card clicks through `handleCardAction` (`value.ask`/`value.opt`)
   with the same operator/privileged rule as permission cards. CLI wiring:
   `--lark-tools` / `tools.enabled` / `tools.askTimeoutMs` /
   `LARK_ACP_TOOLS_ENABLED`. Unit tests (`lark-tool-server.test.ts`). Public
   exports + CHANGELOG.
2. **Outbound + text-ask** (next): `lark_send_message` (behind a permission
   card) and `lark_ask_text` (captured from the bound operator's next inbound
   message rather than a card click).
3. **Catalog growth**: `list_chat_history`, metadata tools, `upload_image` —
   added individually as needs arise.
4. **stdio-proxy fallback** (only if a target agent lacks HTTP MCP).
5. **E2E test** (design §7): drive the server over a real MCP HTTP client
   end-to-end (`tests/lark-mcp-tools.test.ts`) — not yet written; the unit
   suite covers the token registry and the promise-bridge in isolation.
