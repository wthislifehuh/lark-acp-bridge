Full-repo code review — @4t145/lark-acp

TL;DR: The codebase is well-structured and mostly follows your CLAUDE.md rules, but I found one serious bug that permanently bricks a chat after an agent crash, plus three smaller lifecycle bugs. On your token quesproduced (and billed) by the agent itself; the card is pure display. What does cost extra tokens on the bridge side is the context prefix injected into every message, and the Amazon Q adapter's history replay. Concrete optimizations below.

---

Part 1: Your token question

Does the message card consume tokens?

No. Data flows one way: the agent emits agent_thought_chunk / agent_message_chunk events over ACP → the bridge accumulates them into a timeline → renders a card JSON → patches the Lark message. Nothing from the card is ever fed back into the model. Card patches cost Lark OpenAPI quota (rate limits), not tokens. Hiding thoughts with --hide-thoughts only changes display — the model still generated (and you still paid for) those reasoning tokens.

Why does a short message produce long reasoning?

Two causes:

1. Agent-side (the main one). Gemini CLI runs a thinking-enabled model that reasons by default, even for "who are you"by configuring the agent — the bridge already supports this via preset env/args in config.json:

- Gemini: pass a lighter model, e.g. lark-acp proxy --agent gemini -- --model gemini-2.5-flash
- Claude Code: "env": { "MAX_THINKING_TOKENS": "..." } on the preset

2. Bridge-side amplifier. enqueueWithContext (src/bridge/bridge.ts:348) prepends [上下文: 群聊 "..." (oc_xxx) 中用户 XXX (ou_xxx) 的消息] to every single message. This costs ~30–60 input tokens per turn, and worse, gives is literally analyzing "the user's perspective on my role and our interaction", which is the model chewing on that context wrapper.

Real token sinks in this repo, ranked

┌─────────────────
│ Source │ Cost │ Fix │
├────────────────────────────┼──────────────────────────────────┼────────────────────────────────┤
│ │ │ Agent-side config (model │
│ Agent reasoning tokens │ Largest, per-turn │ choice / thinking budget) — │
│ │ │ document per preset │
├─────────────────
│ Context prefix every │ ~30–60 tokens × every turn │ Send once per session, or only │
│ message │ │ when it changes │
├────────────────────────────┼──────────────────────────────────┼────────────────────────────────┤
│ Amazon Q history replay │ O(n²) cumulative — every turn │ Lower defaults; consider │
│ (bin/q-acp-core.ts) │ re-sends up to 24 msgs / 24K │ compacting old turns into a │
│
└────────────────────────────┴──────────────────────────────────┴────────────────────────────────┘

Recommended optimizations

1. Make the context prefix session-sticky (biggest bridge-side win). Track the last-sent (userId, chatId) per ChatRuthe sender changes (group chats). In P2P chats it's the same user every time — sending it repeatedly is pure waste.
2. Shorten the prefix. ou_xxxxx / oc_xxxxx IDs tokenize terribly (~10–15 tokens each) and are useless to an agent with no Lark tools. Make IDs opt-in: [群聊"项目群" 用户张三] carries the same signal at a third of the cost.
3. Add a --no-cont
4. Document that --hide-thoughts ≠ saving tokens, and add per-preset "reduce thinking" recipes to the README (MAX_THINKING_TOKENS for claude, --model gemini-2.5-flash for gemini, etc.).
5. Lark quota (not tokens): raise CARD_FLUSH_DEBOUNCE_MS (src/acp/lark-acp-client.ts:14) from 100ms to ~300–500ms. A fast-streaming answer at 100ms debounce can fire many patchCard calls per second against Lark's rate limits, and each patch re-sends the entire card JSON (which grows with the timeline).

---

Part 2: Bugs (ordered by severity)

🔴 P0 — aborted flag permanently bricks a chat after agent crash

ChatRuntime.aborted (src/bridge/chat-runtime.ts:58) is set to true in shutdown() and handleUnexpectedExit() but never reset to false. Sequence:

1. Agent crashes mid-prompt → handlePromptError → shutdown() → aborted = true, state = null. The runtime stays in LarkBridge.chats (the bridge only deletes it on bootstrap failure).
2. User sends the successfully → pushes to queue → processQueue() hits while (... && !this.aborted) (chat-runtime.ts:217) → aborted is still true → loop never executes.

Result: the message is silently black-holed (no reaction, no card, no error), an orphaned agent process is left running, and since each enqueue refreshes lastActivity, idle eviction never fires either. The chat is dead until the user happens to send /new. Fix: set this.aborted = false after a successful bootstrap in enqueue().

🟠 P1 — bridge.stop() never stops the WebSocket

LarkWsConnection hasthis.ws. After stop(), events keep arriving and handlers run against the cleared chats map. Also started is never reset, so the bridge can't be restarted. Add a stop() that closes/neuters the WS client and reset started.

🟠 P1 — wsClient.start() is fire-and-forget

src/lark/lark-ws.ts:84 — the SDK's start() is async; it's neither awaited nor .catched. Bad credentials or network failure at startup becomes an unhandled rejection (or silent failure), while the log cheerfully pAwait it (or attach .catch) and only log success on resolution.

🟠 P1 — FileSessionStore.close() loses pending writes

The comment at src/session-store/file-session-store.ts:65 says "writes are synchronous" — they're not: scheduleFlush() defe(bin/lark-acp.ts:873), and process.exit discards queued immediates → a save() right before Ctrl+C is silently lost. Fix: close() should perform the flush if one is scheduled. While there: write via tmp-file + rename like q-acp.ts already does (bin/q-acp.ts:325), so a crash mid-write can't corrupt sessions.json.

🟡 P2 — Unbounded card growth hits Lark's card size limit

The timeline is re-r(src/acp/lark-acp-client.ts:283–288). A long session or one big file edit will push the card JSON past Lark's payload limit — patchCard then fails (only logged as warn, src/presenter/lark-presenter.ts:286) and the card silently stops updating, so the user never sees the rest of the answer. Suggest: cap per-entry length (truncate diffs to ~N lines), and on repeated patch failure fall back to replyText for the final answer so content is never lost.

🟡 P2 — Typing reactions accumulate

onTyping fires every 5s and each call addReaction()s again (src/acp/lark-acp-client.ts:411, chat-runtime.ts:147), discarding the returned reaction id. Only the one added in runPrompt gets removed. On long tasks that's a duplicate-reaction API error (caught, logged as warn) every 5 seconds — wasted quota and log noise. Track whether a typing reaction is already present.

🟡 P2 — Unrestricted filesystem access for the agent

readTextFile/writeTextFile (src/acp/lark-acp-client.ts:297–305) let the agent read/write any path with the bridge's privileges — nothing confines it to agentCwd. For a bot reachable by everyone in a Lark workspace, that's worth hardening: resolve against cwd and reject escapes (or at least log every access). Also readTextFile ignores ACP's optional line/limit params and always returns the whole file.

Part 3: Guideline / h

1. Missing toolchain: CLAUDE.md mandates ESLint (strict-type-checked) + tsc --noEmit + prettier in pre-commit and CI — there's no ESLint config, no lint script in package.json, and .github/ workflows worth checking. This is the highest-leverage hygiene fix since several items below would be auto-caught.
2. Two lockfiles: bot modified, bun.lock wasn't). Pick one.
3. Non-null assertion without justification: state.queue.shift()! (chat-runtime.ts:218) — your rules require a comment or a guard; const pending = state.queue.shift(); if (!pending) break; is cleaner.
4. Unsafe as casts: (u.status ?? "in_progress") as ToolStatus (lark-acp-client.ts:265), entries as SessionRecord[] read straight from disk without validation (file-session-store.ts:59) — the latter violates "external da
5. Context-prefix session-stickiness — your actual token savings.
6. Add ESLint + tsc --noEmit scripts to close the CLAUDE.md gap.

Want me to implement these? I'd start with the P0/P1 fixes plus the context-prefix optimization as one batch.

6 tasks (1 done, 2 in progress, 3 open)
■ Fix P1: bridge.stop() doesn't close WebSocket
■ Fix P1: unawaited wsClient.start()
□ Fix P1: FileSessionStore.close() loses pending writes
□ Optimize: make context prefix session-sticky
□ Add ESLint config + npm scripts per CLAUDE.md
