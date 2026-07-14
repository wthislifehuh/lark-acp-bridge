# Bridging Microsoft 365 Copilot & Microsoft Copilot Studio to Feishu/Lark via ACP

> Research + design document for the `copilot-studio` and `m365-copilot` agent presets.
> Research date: 2026-07-13. All primary sources are linked inline.

## 1. Executive summary

**Goal**: connect Microsoft 365 Copilot (the chat at `m365.cloud.microsoft/chat`, a.k.a. BizChat)
and Microsoft Copilot Studio agents (`copilotstudio.microsoft.com`) to a Feishu/Lark bot the same
way Claude Code / Kiro / Gemini / GitHub Copilot CLI already connect — through the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com/).

**Search verdict — nothing exists off the shelf.** As of 2026-07-13 there is no ACP adapter for
either product anywhere (checked the official [ACP agents registry](https://agentclientprotocol.com/get-started/agents),
GitHub, and npm). GitHub Copilot CLI's `--acp` mode is the only Microsoft-family ACP agent, and it
is a separate product (GitHub-subscription coding agent) that cannot target Copilot Studio or M365
Copilot. Microsoft's own SDKs speak the Activity Protocol, MCP, and A2A — never ACP. **Both
bridges therefore have to be built, and both are buildable on documented Microsoft APIs**, following
the same pattern this repo already uses for Amazon Q (`lark-acp-q`): a bundled executable that
speaks ACP over stdio to the bridge and Microsoft's protocol upstream.

|                             | Microsoft Copilot Studio                                                                                                                                  | Microsoft 365 Copilot (BizChat)                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| API                         | "Direct to Engine" via [`@microsoft/agents-copilotstudio-client`](https://www.npmjs.com/package/@microsoft/agents-copilotstudio-client) (M365 Agents SDK) | [Copilot Chat API](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/overview) (Microsoft Graph) |
| Status                      | **GA** (SDK v1.6.x)                                                                                                                                       | **Public preview** (`/beta`; "production use not supported")                                                                              |
| Streaming                   | ✅ SSE, per-activity + accumulated typing chunks                                                                                                          | ✅ SSE, cumulative conversation snapshots                                                                                                 |
| Auth                        | Entra ID delegated (`CopilotStudio.Copilots.Invoke`), device-code OK; app-only (client secret) shipping in SDK but service-side rollout still in progress | Entra ID **delegated only** (7 Graph scopes, admin consent); app-only **not supported**                                                   |
| Caller licensing            | None per user — Copilot Studio message billing (Copilot Credits / PAYG) on the tenant                                                                     | **Every calling user needs an M365 Copilot add-on license**                                                                               |
| Cloud limits                | Sovereign clouds supported via `cloud` setting                                                                                                            | **China (21Vianet) not available**; Global/GCC-High/DoD OK                                                                                |
| Feasibility for this bridge | **High — primary target**                                                                                                                                 | Feasible, with caveats — shipped as a second preset                                                                                       |

## 2. Research findings (with sources)

### 2.1 Copilot Studio — the "Direct to Engine" path (recommended by Microsoft)

- Official npm client: `@microsoft/agents-copilotstudio-client` (v1.6.1, Node ≥ 20, MIT,
  [source](https://github.com/microsoft/Agents-for-js)). Constructor takes
  `(ConnectionSettings, token)` — **token acquisition is the caller's job**.
- Streaming API (verified from the shipped `.d.ts` and JS):
  `startConversationStreaming(request)` / `sendActivityStreaming(activity, conversationId)` /
  `executeStreaming(activity, conversationId)` return `AsyncGenerator<Activity>` fed by
  Server-Sent Events (`eventsource-client`). The client itself accumulates "streaming" `typing`
  activities (entity `type: "streaminfo", streamType: "streaming"`, keyed by
  `streamId`/`streamSequence`) so each yielded `typing` activity carries the **cumulative** text;
  the closing `message` activity carries the full text. The SSE stream ends with an `end` event.
- Endpoint shape (verified from `powerPlatformEnvironment.js`):
  `https://{env-id-hex}.{2}.environment.api.powerplatform.com/copilotstudio/.../conversations[/{id}]?api-version=2022-03-01-preview`.
  A `directConnectUrl` (any valid URL — the Copilot Studio "connection string" from
  _Channels → Web app / Native app_, or a local test server) short-circuits URL construction:
  requests go to `{directConnectUrl}/conversations[/{conversationId}]`.
- Conversation id arrives in the `x-ms-conversationid` response header and in each activity's
  `conversation.id`. Conversation state lives server-side → resuming a session = reusing the id.
- Auth ([Power Platform API auth](https://learn.microsoft.com/en-us/power-platform/admin/programmability-authentication-v2),
  [sample README](https://github.com/microsoft/Agents/tree/main/samples/nodejs/copilotstudio-client)):
  Entra app registration (public client), delegated permission **`CopilotStudio.Copilots.Invoke`**
  on the **Power Platform API** (appId `8578e004-a5c6-46e7-913e-12f58912df43`; register its service
  principal with `az ad sp create --id ...` if the API is not visible), token audience
  `https://api.powerplatform.com/.default`. Device-code flow works headlessly (verified in
  Microsoft's own [skills-for-copilot-studio guide](https://github.com/microsoft/skills-for-copilot-studio/blob/main/SETUP_GUIDE.md)).
  Client-credential (app-only) code paths ship in the SDK samples but READMEs still warn
  _"S2S is not currently supported for Copilot Studio; in active development"_ — implemented here
  as an opt-in mode, expect tenant-dependent availability.
- Agent metadata (Environment ID, Schema name) is under Copilot Studio →
  _Settings → Advanced → Metadata_ ([integration guide](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-integrate-web-or-native-app-m365-agents-sdk)).
- Billing: since 2025-09 usage is metered in Copilot Credits (classic answer 1 / generative 2 /
  agentic actions more), prepaid packs or Azure PAYG
  ([billing rates](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management)).
- Alternatives rejected: **Direct Line 3.0** still works (secret-based, true service-to-service)
  but has **no streaming** for Copilot Studio agents and Microsoft steers new work to the Agents
  SDK; **`pac copilot`** has no chat command; the raw Direct-to-Engine REST API is only supported
  through the SDK.

### 2.2 Microsoft 365 Copilot — the Chat API (Graph beta)

- Endpoints (verified against Microsoft Learn reference pages, 2026-03 revision):
  - `POST https://graph.microsoft.com/beta/copilot/conversations` (empty JSON body) → `201` +
    `{ id, status, turnCount, ... }`
  - `POST .../conversations/{id}/chat` → single JSON `copilotConversation`
  - `POST .../conversations/{id}/chatOverStream` → `text/event-stream`; each `data:` event is a
    **cumulative `copilotConversation` snapshot** whose `messages[]` contain
    `#microsoft.graph.copilotConversationResponseMessage` entries with markdown `text`,
    `adaptiveCards`, `attributions` (citations), `sensitivityLabel`. Stream just closes when done
    (no explicit end event).
  - Request body: `message.text` (required), `locationHint.timeZone` (required),
    `additionalContext[]`, `contextualResources.files[].uri` / `.webContext.isWebEnabled`.
- Response `text` embeds pseudo-entity tags (`<Event>…</Event>`, `<Person>…</Person>`,
  `<File>…</File>`) and `[^1^]`-style footnote markers — the adapter strips/normalizes them and
  appends an attribution list.
- Hard constraints (all verified on the reference pages):
  - **Delegated only** — application (bot) identity not supported; personal MSA not supported.
  - Requires **all** of `Sites.Read.All, Mail.Read, People.Read.All,
OnlineMeetingTranscript.Read.All, Chat.Read, ChannelMessage.Read.All, ExternalItem.Read.All`
    (admin consent effectively required).
  - Every calling user needs an **M365 Copilot license**; no pay-as-you-go for Chat.
  - **Beta/preview**: breaking changes possible, "not supported in production".
  - Not available in the 21Vianet (China) cloud.
- The official beta SDK (`@microsoft/agents-m365copilot-beta`) buffers `chatOverStream` into an
  `ArrayBuffer`, so the adapter calls the REST endpoints directly with `fetch` and parses SSE
  itself (also keeps the dependency tree flat).
- Adjacent APIs that can **not** converse (documented for completeness): Retrieval API (GA,
  chunks only), Interaction Export (history export), Search, Meeting Insights. The **Work IQ
  CLI/MCP** (`@microsoft/workiq`, GA 2026-06) is an official _agent over Copilot data_ with
  usage-based billing — a pragmatic alternative surface, but MCP/CLI-shaped rather than a
  chat-completion API, and closed-source; not chosen for v1.

### 2.3 What the identity model means for a Lark bridge

Both APIs execute **as one signed-in Microsoft user** (the account that completed device-code
login). Every Feishu/Lark chat member therefore talks to Microsoft as that single "service user":

- answers are grounded in _that user's_ mail/files/meetings (M365 Copilot) or run under that
  user's Copilot Studio session;
- do **not** point the bridge at a personal account if the bot is reachable by other people;
  use a dedicated service account whose data exposure is acceptable.

This is inherent to Microsoft's current API surface (no app-only chat), not a bridge limitation.

## 3. Design

### 3.1 Shape: two bundled ACP adapter executables

Mirror `lark-acp-q`: each adapter is a small executable that speaks **ACP as an agent** on
stdio (via `@agentclientprotocol/sdk`'s `AgentSideConnection`) and Microsoft's protocol upstream.
The bridge spawns it like any other agent; users opt in with `--agent copilot-studio` or
`--agent m365-copilot`.

```
Feishu/Lark ⇄ lark-acp bridge ⇄ (ACP/stdio) ⇄ lark-acp-copilot-studio ⇄ Direct-to-Engine SSE ⇄ Copilot Studio agent
                               ⇄ (ACP/stdio) ⇄ lark-acp-m365          ⇄ Graph beta Chat API  ⇄ Microsoft 365 Copilot
```

File layout (per repo conventions — pure logic split from process lifecycle, unit tests colocated,
blackbox tests in `tests/`):

```
bin/
  msal-auth.ts                     # shared MSAL helper: device-code login, silent refresh, disk cache
  copilot-studio-acp-core.ts       # pure: env config, activity→markdown, turn stream tracker, auth-error detection
  copilot-studio-acp-core.test.ts
  copilot-studio-acp.ts            # bin: ACP shell + CopilotStudioClient + `login` subcommand
  m365-copilot-acp-core.ts         # pure: env config, SSE parser, snapshot delta tracker, text cleanup
  m365-copilot-acp-core.test.ts
  m365-copilot-acp.ts              # bin: ACP shell + Graph REST + `login` subcommand
tests/
  copilot-studio-adapter.test.ts   # e2e vs fake Direct-to-Engine SSE server (directConnectUrl → 127.0.0.1)
  m365-copilot-adapter.test.ts     # e2e vs fake Graph server (base URL override → 127.0.0.1)
```

New dependencies: `@microsoft/agents-copilotstudio-client`, `@microsoft/agents-activity`
(activity types), `@azure/msal-node` (auth). All Node ≥ 20 — matches this package's engines.

### 3.2 Authentication flow (both adapters)

- **One-time interactive login** (mirrors `q login`): `lark-acp-copilot-studio login` /
  `lark-acp-m365 login` runs the MSAL **device-code flow** in a terminal and persists the MSAL
  token cache to disk (`~/.lark-acp/<adapter>/msal-cache.json`, `0600`). Refresh tokens keep
  subsequent silent acquisition working for months.
- **At bridge runtime**: before each turn the adapter calls `acquireTokenSilent`; if that fails it
  throws an error whose message starts with **`Authentication required:`** — the bridge's
  `isAuthenticationError` recognizes this and tears the runtime down with a clear card instead of
  retrying (same contract as the Q adapter).
- Copilot Studio additionally supports `COPILOT_STUDIO_AUTH_MODE=client-secret`
  (confidential client, `acquireTokenByClientCredential`) for when tenant-side S2S lands, and both
  adapters accept a static bearer token env (`*_STATIC_TOKEN`) for tests/advanced setups.

### 3.3 Session model

| ACP concept             | Copilot Studio                                                                                      | M365 Copilot                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `session/new`           | mint local UUID; conversation started lazily on first prompt (`startConversationStreaming`)         | mint local UUID; `POST /copilot/conversations` lazily on first prompt |
| turn (`session/prompt`) | `executeStreaming(messageActivity, conversationId)`                                                 | `POST .../chatOverStream` (fallback `/chat` when `*_STREAMING=false`) |
| `session/load`          | restore `{conversationId}` from the per-session JSON file — the transcript itself lives server-side | restore `{conversationId}` likewise                                   |
| `session/cancel`        | stop consuming the activity generator (`generator.return()`), report `stopReason: "cancelled"`      | abort the fetch via `AbortController`, report `cancelled`             |

Unlike the Q adapter there is **no transcript replay** — both services hold multi-turn context
server-side, so resume-after-restart only needs the conversation id (persisted per ACP session id
in `~/.lark-acp/<adapter>-sessions/`).

### 3.4 Mapping Microsoft responses → ACP session updates

Copilot Studio (`Activity` objects):

| Activity                                | ACP update                                                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typing` with accumulated streamed text | `agent_message_chunk` (delta vs. already-emitted prefix)                                                                                                                                                                      |
| `typing` without stream info            | ignored (progress signal only)                                                                                                                                                                                                |
| `message`                               | `agent_message_chunk` (remaining delta, or whole text if nothing streamed); multiple messages in a turn separated by blank lines; `suggestedActions` appended as a markdown line; attachments surfaced as a count placeholder |
| `endOfConversation`                     | conversation marked ended → next prompt starts a fresh one                                                                                                                                                                    |
| anything else (`event`, `trace`, …)     | ignored                                                                                                                                                                                                                       |

M365 Copilot (conversation snapshots): each SSE `data:` carries the cumulative response text; the
adapter tracks the last emitted prefix and emits only the delta, holding back incomplete
pseudo-entity tags / footnote markers at chunk boundaries so the cleanup transform
(`<Person>x</Person>` → `x`, `[^1^]` → `[1]`) never sees a torn tag. After the final snapshot it
appends a `> 引用来源:` attribution list when citations are present.

Neither backend exposes tool-call/permission semantics over these APIs, so (like the Q adapter)
there are **no per-tool permission cards** — the ACP `promptCapabilities` advertise text-only.

### 3.5 Configuration surface (env vars, settable via `agents.<preset>.env` in config.json)

Copilot Studio (`COPILOT_STUDIO_*`): `ENVIRONMENT_ID`, `SCHEMA_NAME` (or `DIRECT_CONNECT_URL`),
`TENANT_ID`, `APP_CLIENT_ID`, `CLOUD` (default `Prod`), `AGENT_TYPE` (`Published`/`Prebuilt`),
`AUTH_MODE` (`device-code`/`client-secret`/`static-token`), `CLIENT_SECRET`, `STATIC_TOKEN`,
`LOCALE`, `EMIT_START_EVENT`, `DATA_DIR`, `TURN_TIMEOUT_MS`.

M365 Copilot (`M365_COPILOT_*`): `TENANT_ID`, `APP_CLIENT_ID`, `SCOPES` (defaults to the 7 required
Graph scopes), `BASE_URL` (default `https://graph.microsoft.com/beta`; overridable for sovereign
clouds/tests), `TIMEZONE` (default: system IANA zone), `STREAMING` (`true`/`false`),
`STATIC_TOKEN`, `DATA_DIR`, `TURN_TIMEOUT_MS`.

### 3.6 Testing strategy

1. **Unit** (`bin/*-core.test.ts`): config parsing, delta trackers (streamed typing accumulation,
   snapshot prefix deltas, torn-tag holdback), markdown rendering of suggested actions and
   attributions, auth-error classification, SSE line parser.
2. **Blackbox e2e** (`tests/*.test.ts`, no Microsoft account needed): drive the **built** adapter
   over a real ACP `ClientSideConnection` against a **local fake server**:
   - Copilot Studio: `COPILOT_STUDIO_DIRECT_CONNECT_URL=http://127.0.0.1:<port>/agent` — the SDK
     verifiably accepts any URL and POSTs to `/agent/conversations[/{id}]`; the fake serves
     `event: activity` / `event: end` SSE frames including streamed-typing sequences.
   - M365: `M365_COPILOT_BASE_URL=http://127.0.0.1:<port>/beta` — the fake serves `201` conversation
     creation and snapshot SSE.
   - Assert: initialize caps, streamed chunks, multi-turn conversation-id reuse, `session/load`
     resume across adapter restarts, cancel mid-stream, `Authentication required` propagation on 401.
3. **Manual** (documented in README): `login` → pipe raw ACP JSON-RPC lines → full bridge run.

### 3.7 Out of scope for v1 (documented limitations)

- Per-tool permission cards (no such semantics in either API).
- Adaptive Card rendering beyond a placeholder (+ M365 falls back to the markdown `text` which
  duplicates card content anyway).
- M365 `contextualResources` (file grounding) and `additionalContext` injection.
- Per-Lark-user Microsoft identities (would need an OAuth flow per Feishu user; revisit if
  Microsoft ships app-only chat or the Work IQ A2A surface matures).
- Copilot Studio secondary path via Direct Line 3.0 (no streaming; add only if demand appears).

## 4. Rollout

1. Implement adapters + presets (`copilot-studio`, `m365-copilot`) + tests. ✅ (this change)
2. README (EN/CN): setup guides — Entra app registration click-path, agent metadata lookup,
   `login` flow, limitations tables. ✅ (this change)
3. Windows one-click launchers (`windows/run-copilot-studio.bat`, `run-m365-copilot.bat`). ✅
4. Future: watch for Copilot Studio S2S GA (flip default to client-secret for unattended
   deployments), M365 Chat API GA (drop the beta warnings), Work IQ A2A surface.
