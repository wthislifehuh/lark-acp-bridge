# Architecture & Scaling Plan — CLI vs ACP, and the road to an org-wide / marketplace Lark assistant

> Status: proposal for review, **revised after a code-grounded stress test** (see the changelog note at the end of §2 and the new §4/§7). Nothing here is implemented yet — this is the plan you green-light before I build.
>
> Context inputs (from you):
> - **Purpose**: a **Lark ops / knowledge assistant** — answers questions, drafts docs/messages, drives Lark via `lark-cli` skills (calendar, docs, base, IM…). Mostly read/query + Lark-API writes. *Not* a code-editing agent on the host.
> - **Priority**: build the org-internal product **and** lay multi-tenant foundations **in parallel**.
> - **Hosting**: **Phase 1** — each customer self-hosts their own instance with their own credentials (installable package). **Phase 2 (later)** — we run a hosted SaaS; customers just install the Lark app.
> - **Latency work**: native-ACP agents (Kiro, Copilot) already single-hop; the shimmed agents (Claude/Codex) have a *cold-start* penalty with a cheap fix — see §5.

---

## 0. TL;DR

1. **The "CLI vs ACP" debate is largely a red herring for your goal.** Both the CLI bridge (`lark-coding-agent-bridge`) and our ACP bridge (`lark-acp-bridge`) run an agent as a **local subprocess on one operator machine, under one shared identity**. Neither is multi-tenant. The axis that actually decides "can my whole org use it / can I sell it" is **tenancy + how tightly the agent's tools are scoped**, not the wire protocol.
2. **The online statement is a *cold-start* heuristic, not a scaling one.** "CLI is faster" is a first-message effect (our bridge keeps the agent warm per chat; the CLI bridge re-spawns per message and is likely *slower* in steady state — §2.1). "ACP scales better" conflates **portability** (true) with **scalability** (false; ACP does nothing for multi-tenancy).
3. **Recommended architecture: keep ACP as the internal contract; treat "direct CLI" as an optimization of last resort.** The cold-start gap's cheap fix is to **pin & bundle the ACP shims** (launch via `node`, not `npx -y`) — not to build a bespoke `claude-direct` adapter, which turns out to be a re-implementation of the shim once you keep per-tool permission cards (§5).
4. **Because the bot is a Lark *assistant*, not a code editor, the host blast radius is small — but "assistant" is not "low-risk."** Shared bot-identity enables cross-user data-read escalation, and reading Lark content exposes the agent to prompt injection (§4).
5. **Two live gaps in our bridge, both access control.** Message intake is **ungated** (anyone in the app's availability scope can drive the bot) *and* permission-card clicks are **unauthenticated** (any group member can approve another user's tool call — `bridge.ts` `handleCardAction`). Both are Phase-1 item #1.
6. **Marketplace reality**: "sell on the Lark marketplace" ≈ a **store/ISV app**, which is inherently multi-tenant (one app, events for all tenants keyed by `tenant_key`). That aligns with **Phase 2 (SaaS)**, not the Phase-1 self-host model. Phase 1's realistic distribution is a **licensed installable + guided custom-app setup**.
7. **Access control is a security feature — it ships with tests or it doesn't ship (§7).**

---

## 1. What each project actually is (grounded in the code)

### 1.1 `lark-acp-bridge` (ours) — ACP bridge

- **Lark transport**: custom app + persistent WebSocket (`LarkWsConnection`, `@larksuiteoapi/node-sdk`). No public endpoint required.
- **Agent transport**: spawns a subprocess that speaks **ACP (JSON-RPC 2.0 over stdio)** via `@agentclientprotocol/sdk` (`spawnAndInit` → `ClientSideConnection`, `src/acp/agent-process.ts`).
- **Process lifecycle**: **one agent process per chat, kept warm** (`ChatRuntime`, `src/bridge/chat-runtime.ts`). The first message pays spawn + handshake + `session/new`; later messages reuse the live process and session. Idle chats are evicted after a timeout.
- **For agents without native ACP** (Claude, Codex, Q), the preset launches a **translation shim** — e.g. `npx -y @zed-industries/claude-code-acp` (`bin/agents.ts:46-63`) — which itself spawns `claude`. Path: `bridge → shim → claude`.
- **For native-ACP agents** (Kiro `kiro-cli acp`, Copilot `--acp`): `bridge → agent` (one hop).
- **Strengths**: uniform permission cards, thought/tool timeline, `session/load` resume, one-card-per-task UX, warm steady-state latency, agent portability (11 presets + raw command + custom presets), region switching, bundled bespoke adapters (`q`, `copilot-studio`, `m365`), Windows build.
- **Gaps** (relative to the CLI project): **access control now implemented at both enforcement points but library-level only** (an opt-in `AccessControl`; intake gating + card-action operator binding + `/invite`/`/remove`/`/mention`/`/access` commands + audit logging — see §4.1/§6 item #1 — but **not yet wired into the `lark-acp` CLI**, so a CLI-run bridge stays open), no profiles/workspaces, **`lark-cli` identity policy now implemented at the library level** (an optional `Identity` — `bot-only`/`user-default` policy + `LARK_ACP_*` env injection + prompt-context block, wired into `bridge.ts` but not yet exported from the package index or constructed by the CLI — see §6 item #2), **OS-service generation now wired into the CLI** (a `lark-acp service <install|uninstall|status>` subcommand emits a systemd user unit / launchd LaunchAgent / Task Scheduler task and prints the activate/deactivate/query commands; still no liveness-probe/reconnect-escalation daemon layer — see §6 item #4), **connection keepalive now tunable end-to-end** (a `keepalive` option on `LarkWsOptions` — `pingTimeoutSec`/`handshakeTimeoutMs`/`autoReconnect` — driving the SDK's built-in ping/pong watchdog + reconnect loop, now threaded through `LarkBridge` and surfaced on the CLI via `runtime.pingTimeoutSeconds`/`runtime.handshakeTimeoutMs` in `config.json`; still no separate liveness-probe escalation — see §6 item #4), in-chat commands still minimal without access control (`/cancel`, `/new`).

### 1.2 `lark-coding-agent-bridge` (zarazhangrui) — "direct CLI" bridge

- **Lark transport**: **PersonalAgent app** + the official `@larksuite/channel` SDK (`createLarkChannel`), which bundles message normalization, streaming cards, comment handling, etc.
- **Agent transport**: spawns the CLI **directly** with its native streaming protocol — `claude -p --output-format stream-json --verbose --permission-mode … --resume <id>` (`src/agent/claude/adapter.ts`), translating `stream-json` → internal events. Codex uses native `jsonl`.
- **Process lifecycle**: **spawns a fresh `claude -p` process per message batch**, relying on `--resume` to reload state each turn. Near-zero idle footprint (no live process between turns), at the cost of a full spawn + resume on every message.
- **Strengths**: low cold-start latency (one hop, no `npx`), near-zero idle memory, mature **access control** (owner auto-detect, `/invite user|group|admin`, private-by-default, **signed card callbacks**), **profiles** (separate Claude/Codex bots), **workspaces** (`/cd`, `/ws`), **`lark-cli` identity policy** (`bot-only` vs `user-default`), **daemon/service management** (launchd/systemd/schtasks), **WS keepalive/reconnect escalation**, COT process messages, opt-in telemetry hook.
- **Weaknesses**: tightly coupled to each CLI's private output format (a separate parser per agent: `stream-json.ts`, `jsonl.ts`); no *uniform* tool/permission model across agents — because `claude -p` print mode can't pop per-tool prompts, it maps everything to `bypassPermissions` / `acceptEdits` / `plan`; adding a new agent means writing a new bespoke parser rather than "it speaks ACP, done."

### 1.3 Head-to-head

| Dimension | Direct CLI (`lark-coding-agent-bridge`) | ACP (`lark-acp-bridge`, ours) |
|---|---|---|
| Process lifecycle | Spawn `claude -p` per message (resume each turn) | Spawn once per chat, keep warm |
| First message (cold) | Faster (one Claude spawn) | Slower (`npx` + shim + Claude spawn) |
| Follow-up messages (warm) | Re-spawn + resume each turn | **Faster** (reuse live session) |
| Idle memory footprint | Near-zero | Full process(es) per retained chat |
| Native-ACP agents (Kiro/Copilot) | Not supported | Single hop |
| Add a new agent | New bespoke output parser | Point at any ACP server (or one thin adapter) |
| Uniform permission / tool / thought UX | Per-agent, ad hoc | Yes, protocol-level |
| Session resume | Native `--resume` | ACP `session/load` / `resume` |
| Access control — intake | Mature | **Absent** |
| Access control — card actions | Signed callbacks | **Unauthenticated** |
| Profiles / workspaces | Yes | No |
| `lark-cli` identity policy | Yes | No |
| Daemon / service mgmt + keepalive | Yes | Partial (`service` subcommand + tunable keepalive; no watchdog escalation) |
| Multi-tenant / org-scale | **No** | **No** |

**Takeaway:** the CLI project wins on *cold-start* latency, idle memory footprint, and the operational features you need for "whole org" (access control at both enforcement points, daemon, identity policy). Our project wins on agent portability, uniform UX, and *warm* (steady-state) latency. **Neither wins on scale — both are single-tenant.**

---

## 2. Stress-testing the online statement

> *"If your goal is latency, raw speed, and simplicity for private usage, build a Direct CLI Bridge. If your goal is scalability, running complex tool calls natively, or sharing with a team, stick with the ACP Bridge."*

### 2.1 "CLI is faster / lower latency" — **a cold-start effect that inverts in steady state**
Both spawn a local subprocess; neither is network-remote. But the two projects have **opposite process lifecycles**, which the "CLI is faster" claim ignores:
- **Our ACP bridge keeps the agent warm per chat** (`ChatRuntime`): first message pays spawn + ACP handshake + `session/new`; every message after reuses the live process and session.
- **The CLI bridge re-spawns `claude -p` per message batch** and reloads via `--resume` each turn.

Therefore:
- **First message in a chat**: CLI bridge is faster — our path pays `npx -y` resolution + a shim spawn + a Claude spawn; theirs pays one Claude spawn.
- **Every message after that (the common case)**: *our* warm-session path is likely faster — it skips process spawn entirely, while the CLI bridge re-spawns `claude` and re-resumes on every turn.

Net: "CLI is faster" is a **cold-start** statement — real at bootstrap, modest in size (tens–low-hundreds of ms), **vanishing for native-ACP agents** (no shim), and **inverting once a chat is warm**. The dominant *fixable* cost on our side is `npx -y` resolution on the shim spawn, addressed cheaply in §5 — not by building a new adapter.

### 2.2 "ACP scales better" — **mostly false for your goal**
- Neither architecture is multi-tenant. Both: one operator machine, one agent subprocess per chat, small concurrency cap (`maxConcurrentChats` / `maxConcurrentRuns` ≈ 10), **one shared agent identity + one filesystem**.
- ACP's real advantage is **portability/uniformity** (swap or add agents without rewriting the bridge) — that's *maintainability*, not *scalability*. The statement conflates the two.
- What actually gates "whole org + marketplace": **identity/data isolation, per-tenant install/OAuth, sandboxed or hosted compute, and app packaging (custom vs ISV/store app)** — all orthogonal to CLI-vs-ACP.

### 2.3 "Run complex tool calls natively" — **overstated**
- The CLI bridge renders tool calls too (`tool-render.ts`), so it's not "only ACP can do tools."
- ACP's genuine edge: a **uniform** tool-call + per-tool-authorization + thought model across *all* agents. Direct-CLI parsing must re-implement this per CLI, and print-mode / text-only agents can't do per-tool auth at all (documented for `q`; also why the CLI bridge runs `claude` in a fixed permission mode).

### 2.4 "Sharing with a team" — **the statement gives false comfort**
- Neither bridge ships team-sharing safely out of the box. Our bridge has **no access control at all** (and unauthenticated card clicks — §4.1); the CLI bridge has good *single-instance* access control but is still one shared identity on one box.
- "Sharing with a team" in the real sense (many users, isolation, admin controls) is **new work regardless of protocol** — see §4 and Phases 1–2.

**Verdict:** treat the statement as a rough heuristic for *private, single-user* setups. For "whole org + marketplace" it's the wrong frame. Recover the cold-start cost cheaply (§5), and spend the real effort on access control + tenancy + packaging.

> **Stress-test changelog (this revision):** the previous draft claimed a direct adapter would deliver "CLI-level latency" and listed it as *the* latency win. Grounding that against `chat-runtime.ts` (warm-per-chat) and `claude -p`'s inability to pop per-tool prompts showed the win is (a) only at cold-start and (b) cheaply captured by pinning the shim. It also surfaced the unauthenticated card-action path (§4.1) and the idle-memory capacity problem (§6, item 6). §2.1, §5, item #1 and item #6 were rewritten; §4 (security) and §7 (verification) added.

---

## 3. The real decision axis for your goal

Your goal decomposes into two orthogonal questions the CLI-vs-ACP framing ignores:

1. **Tenancy**: is there one shared agent identity/host (single-tenant) or per-org/per-user isolation (multi-tenant)?
2. **Tool scope**: what is the agent allowed to touch? A Lark assistant (Lark API calls scoped by tokens) is *dramatically* safer to share than a coding agent (arbitrary shell/file writes).

Because you chose **assistant purpose**, host tool scope is favorable: the blast radius of a shared identity is Lark operations bounded by the app's scopes and the `lark-cli` identity policy — not `rm -rf` on a shared box. This is why the eventual SaaS is realistic without heavy per-user *filesystem* sandboxing. It is **not**, however, risk-free — the risks move from the host to the Lark data plane (§4).

The **recommended architecture principle** that falls out of this:

> **ACP is the internal contract; "direct CLI" is an optimization; tenancy + access control + packaging are the real product.**

Keep the ACP-shaped bridge (uniform UX, portability, your card presenter). Recover the cold-start cost cheaply (§5). Invest the bulk of effort in access control + the security model now (§4), and multi-tenancy later (§6).

---

## 4. Security model & threats

The bot is a Lark assistant, so the blast radius excludes host shell/file destruction — but "assistant" ≠ "low risk." Three threats matter for an org deployment and are non-negotiable for a sellable product; a fourth (audit) is table stakes for buyers.

### 4.1 Card-action authorization — a live bug today
`handleCardAction` (`src/bridge/bridge.ts:419-476`) resolves a permission card purely by `requestId` + `optionId` — it **never checks who clicked**. Consequences:
- In a group, **any member** can approve (or deny) a tool authorization requested during another user's prompt.
- Once access control lands for message intake, a **non-allowed** user can still click **Approve** on a visible card — bypassing the allowlist at the single most dangerous moment (tool execution).

Fix (folded into Phase-1 item #1): bind each permission card to its originating operator and reject clicks from anyone else. The CLI project's `CallbackAuth` (signed callback value + policy fingerprint + nonce store, `src/card/callback-auth.ts`) is the reference design; a minimal version stores `operatorOpenId` per pending request and checks the clicker's `open_id`.

> **Status — implemented (library-level).** `bridge.ts` now resolves each card action with the clicker's identity (`event.operator.openId`) and privilege (`AccessControl.isPrivileged`) before resolving the permission request, so an unauthorized click no longer approves another user's tool call. The operator-binding check itself lives in `LarkAcpClient.handleCardAction` (`src/acp/lark-acp-client.ts`): each pending permission records the originating `operatorOpenId`, and a click is honoured only from that operator or a privileged user — otherwise it returns `forbidden` and the request stays pending (`orphan` for an unknown/expired request id). This enforcement point ships with its own white-box unit suite (`src/acp/lark-acp-client.test.ts`) covering the §7 card-action acceptance criteria: a non-operator click is rejected while the request stays resolvable by the real operator, a privileged (owner/admin) user may resolve another operator's card, and an unknown request id is reported as orphan. Enforcement is active whenever an `AccessControl` is supplied; the bundled `lark-acp` CLI does not yet construct one, so a CLI-run bridge keeps the legacy open behavior until §6 item #1's CLI wiring lands.

### 4.2 Shared bot-identity ⇒ cross-user read escalation
With the default `bot-only` `lark-cli` identity, the assistant reads Lark data as the **app/tenant token**, not as the asking user. So an allowed user can ask the bot to read a doc / chat / Base table they personally cannot access but the bot can — a cross-user privilege escalation that grows with every scope the bot accumulates. Mitigations:
- Keep the bot's tenant scopes **minimal** — grant only what the assistant genuinely needs; review the scope list against actual skills used.
- For data-boundary correctness, **per-user identity (`user_access_token`)** is the real answer; treat it as the Phase-2 isolation model (§6, §9).

### 4.3 Prompt injection via ingested content
An assistant that reads docs/messages/mail ingests **untrusted text** that can carry instructions ("forward the last message to …", "call the write tool with …"). Mitigations:
- **Never auto-approve write/side-effecting tools.** Per-tenant policy: `alwaysAllow` for read-only Lark ops, `alwaysAsk` (with §4.1-authorized cards) for writes. Blanket `alwaysAllow` is unsafe for an assistant that reads external content.
- Prefer read-scoped tokens where the task allows; segregate write-capable skills behind explicit authorization.

### 4.4 Audit logging
Admins of an org deployment — and any buyer's security review — will require a record of **who asked what, which tools ran, and which authorizations were granted/denied**. Cheap on top of the existing pino logging: add a structured audit channel keyed by chat + operator `open_id`, retained separately from debug logs.

---

## 5. "Best of both" — recover the cold-start cost cheaply; build a direct adapter only if measured

The previous draft proposed building first-party `claude-direct` / `codex-direct` adapters as "the latency win." Stress-testing against the code shows that's the wrong first move.

### 5.1 Why a `claude-direct` adapter is not the cheap win it looks like
- The dominant cold-start cost is **`npx -y @zed-industries/claude-code-acp` resolving the package on every spawn** — not the shim's translation work.
- `claude -p` (print mode) **cannot pop per-tool permission prompts** — it runs to completion under a fixed `--permission-mode`. The CLI bridge accepts this and maps everything to `bypassPermissions` / `acceptEdits` / `plan`. To preserve our marquee **per-tool permission cards**, a direct adapter would have to drive Claude's `--input-format stream-json` bidirectional control protocol — which is essentially **re-implementing the zed shim**, inheriting exactly the format-drift maintenance burden §9 warns about.

### 5.2 The cheap win — pin & bundle the shim, drop `npx`
- Add `@zed-industries/claude-code-acp` (and the Codex equivalent) as **pinned `dependencies`**, and change the `claude` / `codex` presets to launch `node <resolved-entrypoint>` instead of `npx -y …`. This removes the npx resolution/cold-start — the actual dominant cost — with near-zero new code, no bespoke parser, and no loss of permission cards.
- Pinning also fixes a supply-chain / reproducibility problem: `npx -y` silently pulls whatever is latest at spawn time.
- Acceptance guard: presets must launch with no network access to npm, and permission cards must still function (§7).

> **Status — partially implemented (refined approach).** Rather than forcing every install to bundle five heavyweight agent packages as hard `dependencies`, the bridge takes an **opt-in, `dataDir`-local** variant of the pin-&-bundle win (`bin/shims.ts`). An operator prepares the shims once into a `<dataDir>/shims` directory; thereafter `preferPreparedShim` rewrites an `npx -y <pkg> [args…]` preset launch to run the shim's resolved bin entrypoint directly with the current `node` — no `npx` resolution, no network, and a version pinned by the prepared install. The rewrite is a pure *launcher* change (same shim binary), so per-tool permission cards and every other behaviour are untouched. This runtime side is **wired into `runProxy`**: the resolved launch is logged with a `[prepared]` tag when a prepared shim is used, and when it falls back to `npx` the CLI prints a tip suggesting `lark-acp prepare`. When a shim isn't prepared the original `npx` invocation is used unchanged, so nothing regresses. The launcher logic ships with a white-box unit suite (`bin/shims.test.ts`) covering `npx`-invocation parsing (`parseNpxInvocation` / `stripVersion`), prepared-bin resolution from a package's `bin` field including scoped/object-form bins (`resolvePreparedBin`), and the launch rewrite itself (`preferPreparedShim`) — asserting trailing args are preserved and that a non-prepared or native (non-`npx`) invocation is left unchanged. **Not yet done:** the `lark-acp prepare` subcommand that would create the prepared install (parse the preset's `npx` spec and `npm install` it under `<dataDir>/shims`) is argument-parsed (`prepare [--agent <id>] [--config <path>] [--data-dir <dir>]`) but **not yet dispatched/executed** in the CLI's command switch, so preparing shims is not functional end-to-end. Pinning the Codex shim and the acceptance guard (offline launch + cards still functional) also remain outstanding.

### 5.3 Only if measured latency still hurts — a real direct adapter
Treat it as a **project**, not a thin wrapper: a `--input-format stream-json` control-protocol implementation + per-version format tracking. Keep it strictly behind the ACP boundary so the bridge and every other agent stay uniform (the §5.5 principle).

### 5.4 Optional deeper cut — in-process ACP connection (later)
Today `LarkBridgeAgentOptions` only accepts `command`/`args` (always a subprocess). A later library extension could accept an **in-process ACP connection factory**, collapsing a bundled agent to a true single hop with the bridge staying ACP-shaped internally. Nice-to-have; defer unless latency proves critical after §5.2.

### 5.5 What we deliberately *don't* copy
We do **not** adopt per-agent bespoke output parsing as the primary architecture (it doesn't scale to N agents and loses uniform UX). Direct parsing lives **only inside** a direct adapter, behind the ACP boundary. Native-ACP agents (Kiro, Copilot) are already single-hop and need nothing here.

---

## 6. Phased roadmap

### Phase 1 — Harden the self-hostable, org-wide assistant (NOW)

Prioritized by value for "everyone in the org can use it, reliably, safely." Most of this is *porting proven designs* from `lark-coding-agent-bridge`, adapted to our ACP bridge. Each item ships with the §7 acceptance tests.

1. **Access control — two enforcement points, not one (highest priority).**
   - **Message intake**: owner auto-detect, private-by-default, allowlists with in-chat management (`/invite user|group|admin`, `/remove …`), require-@mention-in-groups toggle. Wire into `bridge.ts` `routeMessage` (currently ungated). Adapt from the CLI project's `src/policy/access.ts`.
   - **Card actions** (§4.1): bind each permission card to its originating operator and reject clicks from others. Without this the allowlist is bypassable at tool-approval time.
   - **State & owner detection**: mutable allowlists live in an **atomically-written state file under `dataDir`** — *not* the user-owned `config.json`, which is read once at startup (reuse the tmp-file+rename pattern from `file-session-store.ts:140-150`). Owner auto-detect polls the application-info API for `ownerId` (CLI project's `src/policy/owner.ts`), which needs an application-info scope **our current scope list lacks** — provide an `access.ownerOpenId` config fallback for when that API/scope is unavailable. `/invite user @name` also needs **mention-target parsing** the interpreter doesn't do today (it only detects bot-mention).

   > **Status — partially implemented (library-level).** The `access-control/` module + `AccessControl` (exported from the package) now enforce both points: message intake is gated in `bridge.ts` `routeMessage` (private-by-default; owner/admin/user/group allowlists; `requireMentionInGroup` toggle) and card actions are bound to the clicking operator (§4.1). In-chat management is wired — `/invite user|admin|group`, `/remove …`, `/mention on|off`, `/access` — with mention-target parsing added to the interpreter, and the allowlist persisted to an atomically-written `dataDir` state file (`FileAccessStore`) that takes effect on the next message without restart. Every decision/mutation emits an `audit`-tagged log line. The module ships with a white-box unit suite (`src/access-control/access-control.test.ts`) covering the §7 intake acceptance criteria: private-by-default, first-DM ownership claim + `configuredOwner` precedence, DM/group allowlist gating, owner lock-out protection, the group @-mention toggle, and persistence across a simulated restart. **Not yet done:** application-info-API owner auto-detect (the current impl uses first-DM ownership claim + a `configuredOwner` fallback instead) and **wiring `AccessControl` into the `lark-acp` CLI** — until then a CLI-run bridge stays open.
2. **`lark-cli` identity policy + safe env injection.** `bot-only` (default) vs `user-default` (allow authorized user identity for personal resources), a `dataDir`-local `lark-cli` config dir, and injecting the chat context (chat id, sender, group) into the prompt so the assistant can chain into `lark-cli` skills. **We have no profile system to hang this off** (the CLI project does), so this needs its own config-dir + env-injection design, not a direct port — larger than "adapt from `src/lark-cli/*`" implies. Directly mitigates §4.2.

   > **Status — partially implemented (library-level).** The `identity/` module + optional `Identity` now cover both concerns. **Identity policy**: `bot-only` (default) / `user-default`, exposed to the agent subprocess through a documented `LARK_ACP_*` env contract (`IDENTITY_ENV`: policy, chat id, a lazily-created `dataDir`-local `configDir` a Lark-aware tool can use for its token cache, domain, and — off by default — the app credentials) built in `bridge.ts` `buildAgentEnv` and injected once at spawn (warm-per-chat constraint). **Prompt-context injection**: a per-message structured block naming the chat (p2p/group + id/name) and sender (name/open_id) plus the active identity policy, prepended to the prompt so the agent can chain into Lark skills with the right ids; when no `Identity` is supplied the bridge falls back to its built-in minimal context and injects no identity env. **CLI wiring — done.** `Identity` is now exported from the package top-level index and the `lark-acp` CLI constructs one on every `proxy` run, sourcing its policy/flags from a `--identity <policy>` / `--inject-lark-credentials` CLI flag, a `LARK_ACP_IDENTITY` env var, and an `identity` config block (`identity.policy` / `identity.injectCredentials` / `identity.promptContext`) in `config.json` — so a CLI-run bridge now injects identity context by default. **Not yet done:** genuine per-user `user_access_token` acquisition (`user-default` currently only *signals* the intended acting identity — a Phase-2 concern, §4.2/§9).
3. **Operability commands + status.** `/status` (identity, access, session, agent), `/help`, `/config` (presentation + access + identity policy + per-tenant permission policy from §4.3). Non-technical org users and admins need these.

   > **Status — in progress.** The three commands are recognized by the interpreter (`/help`/`帮助`, `/status`/`状态`, `/config`/`配置` — new `LarkCommand` kinds) and routed in `bridge.ts` to `handleHelp` / `handleStatus` / `handleConfig`. `handleStatus` now also surfaces the **WebSocket connection state** — a `describeConnection()` helper reads `LarkWsConnection.getConnectionStatus()` (the same lifecycle snapshot exposed by the §6 item #4 keepalive work) and renders `state`, appending the reconnect-attempt count when non-zero. The remaining handler bodies (help text and effective-config summary) are still being filled in.
4. **Daemon / service management + connection watchdog.** `start` / `stop` / `status` / `restart` as an OS service (systemd/launchd/Windows Task Scheduler), adapted from `src/daemon/*`. Also port a **liveness probe + reconnect escalation** (the CLI project runs a 15s keepalive); we currently lean on SDK internals alone, which is thin for an unattended self-host box.

   > **Status — connection-keepalive tuning + OS-service-definition generation + `service` CLI subcommand done (library + CLI); watchdog escalation not started.** `LarkWsConnection` now takes an optional `keepalive` (`LarkWsKeepaliveOptions`) on `LarkWsOptions` (`src/lark/lark-ws.ts`, exported from the `lark` module index) exposing three knobs onto the SDK's built-in watchdog/reconnect loop rather than a competing one: `pingTimeoutSec` (liveness window → `wsConfig.pingTimeout`), `handshakeTimeoutMs` (abort a stuck handshake → `handshakeTimeoutMs`), and `autoReconnect` (default `true`). This makes the "lean on SDK internals alone" default *tunable* for an unattended box. The option is now threaded through `LarkBridge` (`bridge.ts` forwards a `keepalive` block to the WS connection) and surfaced on the CLI: `config.json` `runtime.pingTimeoutSeconds` / `runtime.handshakeTimeoutMs` (defaults 60s / 15000ms; `0` disables each) feed the bridge's `keepalive`, and the `proxy` startup banner logs the effective `ping-timeout` / `handshake-timeout` / `auto-reconnect` settings. Separately, **OS-service-definition generation** exists as a pure, testable builder (`bin/service.ts`): `buildServiceDefinition(spec)` emits a platform-appropriate definition — a systemd **user** unit on Linux, a launchd **LaunchAgent** on macOS, and a Task Scheduler task XML on Windows — returning the file path, the file contents, and the exact `activate` / `deactivate` / `status` commands the operator runs. Generation is deliberately pure: it does not touch the service manager, so activation stays a one-command operator step (and user-level units need no root). **CLI wiring — done.** The `lark-acp service <install|uninstall|status>` subcommand (`runService` in `bin/lark-acp.ts`) now calls the builder: `install --agent <preset>` resolves the run config, embeds a fixed `proxy --agent …` argv (with `--config` / `--data-dir` / `--cwd` / `--domain`), writes the definition to its platform-conventional path, and prints the activate commands; `uninstall` removes the file and prints the deactivate commands; `status` reports whether the definition is present and prints the query command. Activation itself is still left to the operator by design. **Not yet done:** there is still no separate liveness-probe + reconnect-escalation layer beyond the SDK's own watchdog.
5. **Cold-start latency: pin & bundle the shims (§5.2).** Replace `npx -y …` with pinned dependencies launched via `node`. Build a direct adapter only if measured latency still warrants it (§5.3). *Downgraded from the earlier "build `claude-direct`/`codex-direct`."*

   > **Status — partially implemented.** The launcher-rewrite mechanism (`bin/shims.ts` `preferPreparedShim`) is done and wired into `runProxy`: a preset that launches via `npx` is rewritten to run a prepared shim directly with `node` when one exists under `<dataDir>/shims`, logged with a `[prepared]` tag, with a `lark-acp prepare` tip on the `npx` fallback path. The refinement vs. the §5.2 plan is that shims are prepared **opt-in into `dataDir`** instead of bundled as hard dependencies, avoiding install bloat. The launcher logic is covered by a white-box unit suite (`bin/shims.test.ts`). **Not yet done:** the `lark-acp prepare` subcommand is argument-parsed but not yet dispatched, so the prepared install can't be created through the CLI yet; the acceptance guard (offline launch + cards still functional, an integration-level check) also remains outstanding.
6. **Capacity model & fairness — a decision, not a review.** Persistent per-chat processes are memory-bound: shim + `claude` ≈ hundreds of MB per active chat. `maxChats` 10 for a 200-person org means constant LRU eviction (every evicted chat re-pays bootstrap); `maxChats` 100 could mean **10–30 GB RAM**. This is the one axis where the CLI project's spawn-per-run model genuinely scales better (near-zero idle footprint). Decisions to make:
   - Default to **shorter idle timeouts + warm-LRU sizing** tuned to host RAM.
   - Offer a **per-run-spawn execution mode** (config option) for high-headcount, latency-tolerant deployments — trades warm-start latency for near-zero idle memory (borrow the CLI project's model + its `ProcessPool` cap).
   - Add **per-user rate limiting** so one user can't monopolize chat slots or model quota.
7. *(Lower priority for an assistant)* Workspaces/multi-project (`/cd`, `/ws`) — more relevant to coding agents; defer or skip.

Deliverable of Phase 1: a **licensed, self-hostable package** a customer installs, points at **their own custom Lark app**, and safely opens to their whole org with admin controls and an audit trail.

### Phase 2 — Multi-tenant SaaS / ISV marketplace app (FOUNDATIONS in parallel, BUILD later)

The true "buy it on the Lark marketplace, click install, done" product. Assistant-purpose makes this tractable (no per-user code sandbox), but it is a **different backend**, not a config flag on Phase 1.

- **App model**: a **store / ISV app** (one registration; events for all installed tenants keyed by `tenant_key`; auth via app + per-tenant tenant-access-token). *Note*: ISV apps typically receive events via **HTTPS callback** (with encrypt/verification), so the current WS-long-connection-only transport likely needs a webhook path added — confirm current Lark long-connection support for ISV before committing (§9).
- **Multi-tenancy core**: per-tenant credential/token store, event routing by `tenant_key`, per-tenant + per-user session isolation, per-tenant `lark-cli` identity isolation.
- **Per-user identity** (the §4.2 answer): move data-sensitive skills onto `user_access_token` so the assistant reads within the asking user's own permissions, not the bot's.
- **Agent execution at scale**: move off "one local CLI login per box." Options: (a) hosted-model path via the **Claude Agent SDK / Anthropic API** (`claude-agent` preset direction) — no local subprocess per user; (b) pooled/sandboxed workers (containers/microVMs) if a local runtime is still needed. Assistant tools = Lark API calls, so (a) is likely sufficient and cheapest to isolate.
- **Product plumbing**: install/onboarding flow, admin console, per-seat/tenant billing & licensing, data residency (`feishu` vs `lark` domains, China 21Vianet constraints), security review, observability/metrics (extend the CLI project's opt-in telemetry hook into first-class SaaS monitoring; build on the §4.4 audit channel).
- **Foundations to lay now (cheap, done during Phase 1)** so Phase 2 isn't a rewrite:
  - Keep all tenant-specific state keyed by an explicit tenant id even in single-tenant mode (don't bake in "one app").
  - Abstract the Lark transport behind an interface so a webhook/ISV transport can slot in beside the WS one.
  - Abstract agent execution behind the ACP boundary (already true) so a hosted-model executor can replace subprocess spawning.
  - Structured, tenant-tagged, audit-grade logging/metrics from day one.

---

## 7. Verification & acceptance criteria

Access control is a security feature; it ships with tests or it doesn't ship. The repo's mock-agent + vitest infrastructure (`bin/mock-agent.ts`, `tests/`) makes black-box verification straightforward — drive real Lark-shaped events through the bridge against the mock agent and assert on gating. Minimum acceptance per Phase-1 item:

- **Access control (intake)**: non-allowed DM → silently ignored; non-allowed group message (even @-mention) → ignored (or the single-line hint, per chosen policy); owner and admins bypass lists; `/invite` / `/remove` mutate the `dataDir` state file and take effect on the **next message without restart**; the owner can never lock themselves out.
- **Access control (card actions, §4.1)**: a permission card approved by a non-operator / non-allowed user is **rejected and the tool does not run**; only the originating operator's click resolves it; expired/orphan cards are handled gracefully.
- **`lark-cli` identity**: `bot-only` never exposes a user's personal-scope data; switching to `user-default` requires *that user's* authorization; identity does not leak across chats/users.
- **Cold-start pinning (§5.2)**: presets launch with **no network access to npm** (no `npx` resolution); permission cards still function (regression guard for the shim swap).
- **Capacity & fairness**: at `maxChats` + 1 active chats, eviction picks a **non-processing** chat; per-user rate limit rejects a flood without starving other users; per-run-spawn mode (if built) produces the same card/permission behavior as warm mode.
- **Audit (§4.4)**: every run and every tool authorization decision produces an audit record with chat + operator identity.
- **Regression**: existing `/cancel`, `/new`, session-resume, permission-card, and typing-reaction flows still pass.

CI should run these across the three OSes the package targets (the Amazon Q integration suite already runs adapter e2e against a fake binary — extend that pattern rather than inventing a new harness).

---

## 8. Marketplace vs self-host — the tension to be aware of

- **Custom app (自建应用)**: built by a tenant for its own use; not sold. **This is the Phase-1 self-host model** — each customer creates their own custom app and runs your binary with their own credentials.
- **Store / ISV app (商店应用)**: listed in the Lark app directory, installable by any org, inherently multi-tenant. **This is the Phase-2 marketplace product.**
- Consequence: "each customer self-hosts their own instance" and "buy it on the marketplace and click install" are **different distribution models**. In Phase 1, "display on the marketplace" is realistically a **listing that drives customers to a guided self-host deployment** (or a thin companion store app for branding/setup), while the actual compute stays on the customer's box. The clean one-click marketplace story arrives with the **Phase-2 SaaS**.
- Recommendation: state this explicitly to buyers, ship Phase 1 as a licensed self-host product, and treat the ISV/store-app listing as the Phase-2 milestone.

---

## 9. Risks & open questions

- **ISV event transport**: does Lark currently support persistent-connection event delivery for ISV apps, or is an HTTPS callback endpoint required? Determines how much of the transport layer Phase 2 must add. (Action: verify in Lark open-platform docs before Phase 2.)
- **Application-info scope for owner detection**: owner auto-detect needs an application-info permission not in our current scope import. Confirm the scope name and add it, or rely on the `access.ownerOpenId` fallback (§6 item 1).
- **Agent identity in SaaS**: does the assistant act as the **app/bot** identity, the **end user** identity, or both (per the `lark-cli` identity policy)? Drives the OAuth scopes and the §4.2 isolation model.
- **Licensing mechanism**: "licensed installable" (§6/§8 deliverable) has **no enforcement design yet** — license-key format, offline validation, grace/revocation. Needs a decision before Phase-1 GA.
- **Attribution / license hygiene**: `lark-coding-agent-bridge` is MIT; porting its designs is fine, but any **copied code must retain attribution** (as we already do for the 4t145 fork). Prefer clean-room re-implementation where practical.
- **Cost model**: per-user hosted-model inference (Anthropic API) vs. shared — affects pricing/billing design.
- **Per-tool authorization UX at org scale**: `alwaysAsk` cards are great for one user but noisy for an org; the per-tenant policy from §4.3 (curated safe read-only set on `alwaysAllow`, writes on `alwaysAsk`) is the intended answer — validate it feels right in practice.
- **Direct-adapter maintenance (conditional)**: *only if* we build the §5.3 adapter, `claude`/`codex` private output + control-protocol formats change across versions and must be tracked. The pinned zed shim (§5.2) absorbs that for us today — a deliberate trade-off in favor of not owning the parser.

---

## 10. Immediate next steps (pending your green-light)

Suggested build order (Phase 1). My default recommendation is **1 → 2 → 3**, since access control is the gating feature for both "whole org" and "sellable," and items 2–5 all assume an owner/admin concept exists.

1. **Access control (intake + card-action authorization, §4.1).** Owner + allowlists + `/invite` / `/remove` + group-mention toggle wired into `routeMessage`, **and** operator-bound permission cards in `handleCardAction`; mutable state in `dataDir`; ships with the §7 acceptance tests. *(Recommended first.)*
2. **`lark-cli` identity policy + prompt context injection** (§4.2) — with its own `dataDir`-local config-dir design.
3. **`/status` / `/help` / `/config` commands** (incl. the §4.3 per-tenant permission policy).
4. **Pin & bundle the ACP shims (§5.2)** — the real cold-start fix; direct adapter only if measured.
5. **Daemon/service management + WS keepalive** (§6 item 4).

Capacity/rate-limiting (§6 item 6) and audit logging (§4.4) are folded into the items above as they're touched. I'll also lay the cheap Phase-2 foundations (§6) as I go, so the SaaS build later isn't a rewrite.
