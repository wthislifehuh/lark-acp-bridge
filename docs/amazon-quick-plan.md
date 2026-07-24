# Integrating Amazon Quick (Quick Suite) with Feishu/Lark

> Research + design document for an Amazon Quick integration.
> Research date: 2026-07-21. Revised after the constraint "**we have onboarded to Amazon Quick, not
> Amazon Q Business — focus solely on Amazon Quick.**" All primary sources are linked inline and
> collected in §7.

## 0. The one thing to read first — the integration inverts

The existing agents in this repo (Amazon Q Developer `q`, Claude, Kiro, Copilot, …) are wired as the
**brain behind the Lark bot**: `Lark message → bridge → ACP agent → answer → Lark card`. **Amazon
Quick cannot be wired this way**, because Quick exposes **no API to send a chat agent a prompt and
get a response** (§2.3). Quick's programmatic model is the **opposite direction**: Quick is an **MCP
client** that reaches *out* to tools you host (§2.4).

So "connect Amazon Quick" — for a Quick-only customer — means building the **inverse** topology:

```
  What the repo does today (Q Developer, Claude, Kiro…):
      Lark user ─▶ lark-acp bridge ─▶ (ACP) ─▶ agent ─▶ answer ─▶ Lark
      (the agent is the brain; Lark is the UI)

  What Amazon Quick supports (this plan):
      Quick user ─▶ Amazon Quick chat agent ─▶ (MCP, outbound) ─▶ Lark MCP server ─▶ Lark API
      (Quick is the brain + UI; Lark becomes a set of tools/data Quick can use)
```

This is a **product decision, not just a technical one** — the human-facing surface becomes **Amazon
Quick's chat**, not the Lark bot.

> **Decisions locked (2026-07-21).** (1) **Proceed with the inversion** — Quick→Lark via MCP.
> (2) **Host self-hosted on the operator's laptop behind TLS**, exposed to Quick via a **tunnel**
> (the only way a laptop becomes a public TLS origin — §3.4), and **lay the foundation to move to
> Bedrock AgentCore Gateway** later; if laptop-TLS proves unworkable, start on AgentCore Gateway.
> (3) Ship **read/query tools *and* a selected set of write tools** (writes opt-in, off by default).
> §6/§8 keep the rejected alternatives for the record.

---

## 1. Executive summary

**Goal (restated for the Quick-only reality)**: let people working in **Amazon Quick**
([aws.amazon.com/quick](https://aws.amazon.com/quick/)) use their Quick chat agent to **read from and
act on Feishu/Lark** — search/read docs, query Base, look at calendars/messages, send a message —
by exposing a curated set of Lark tools to Quick over **MCP (Model Context Protocol)**, the
integration channel Quick actually supports.

**Search verdict.** As of 2026-07-21, Amazon Quick's documented programmatic surfaces are:

1. **Embedding SDK** — `GenerateEmbedUrlForRegisteredUser` / `…WithIdentity` (the `quicksight`
   API namespace; Quick's control plane is the evolved QuickSight one). Returns a **signed iframe
   URL** to embed Quick's *own* chat UI in a web page. A browser surface, **not** a text API. (§2.3)
2. **MCP integration** — Quick is an **MCP client**; you register a **remote MCP server** (public
   HTTPS, SSE or streamable HTTP, OAuth) and Quick's agents invoke your tools. **This is the path.** (§2.4)
3. **REST API Connection integration** — Quick calls a custom REST API as an "action" (OAuth / API
   key). Same outbound direction as MCP; a lower-ceiling alternative to it. (§2.5)

There is **no public "invoke chat agent" / "chat" text API** for Quick (§2.3). The `qbusiness`
`ChatSync` API that *would* give text-in/text-out **requires an Amazon Q Business application, which
we do not have** — so it is out of scope by the stated constraint (documented in §6 only as a
"if you ever add Q Business" note).

**Recommendation**: build **`lark-quick-mcp`** — a **public, OAuth-protected MCP server** exposing a
curated Lark tool catalog, reusing the tool *logic* already in `src/lark-tools/` but with a new
public transport + auth + hosting posture (§3). Register it in Quick under **Actions → MCP
integration**. Ship read/query tools first; gate writes.

| | Amazon Quick integration (this plan) |
| --- | --- |
| Direction | **Quick → Lark** (Quick is the MCP client; we host the MCP server) |
| Protocol | **MCP** over **streamable HTTP / SSE**, **public HTTPS** endpoint |
| Auth | OAuth — **2LO / client-credentials** (service-to-service) recommended; 3LO or Dynamic Client Registration also supported by Quick |
| What we build | A standalone Lark MCP server (not an ACP agent preset) — reuses `src/lark-tools/` handlers + `LarkHttpClient` |
| Human surface | **Amazon Quick chat** (not the Lark bot) |
| Feasibility | **High** for the tool-server; the new cost is **hosting a public endpoint** (breaks the bridge's NAT-friendly, no-public-endpoint posture — §3.4) |
| Not possible today | Quick as the *agent behind the Lark bot* (no headless chat API) — §0/§6 |

---

## 2. Research findings (with sources)

### 2.1 What Amazon Quick is

Amazon Quick Suite (GA **October 2025**) is an agentic AI workspace: **Quick Research**, **Quick
Sight** (BI / NL analytics — the evolved Amazon QuickSight), **Quick Flows / Quick Automate**
(automation), and **chat agents** — a system agent ("My assistant") plus custom agents scoped to
specific spaces, knowledge bases, and **action connectors** (tools). Chat agents "help users explore
data, analyze information, and **take actions**," and "can invoke actions to perform predefined
steps," where actions come from **MCP** and **REST API** integrations.
([product](https://aws.amazon.com/quick/),
[announcement](https://aws.amazon.com/blogs/aws/reimagine-the-way-you-work-with-ai-agents-in-amazon-quick-suite/),
[working with agents](https://docs.aws.amazon.com/quick/latest/userguide/working-with-agents.html))

### 2.2 API namespace

Quick's control plane is the **`quicksight` API** (`quicksight-2018-04-01`), rebranded — e.g.
`GenerateEmbedUrlForRegisteredUser` is a QuickSight API operation, and Quick docs live under both
`docs.aws.amazon.com/quick/` and `docs.aws.amazon.com/quicksuite/`. Chat agents are organized by
**namespace** (a Quick org unit). There is **no `quick`/`quicksight` API operation that sends a
prompt to a chat agent and returns its answer** — the chat-agent operations are administrative
(create/customize/share), not conversational.
([QuickSight embedding APIs](https://docs.aws.amazon.com/quicksuite/latest/userguide/embedded-analytics-api.html),
[GenerateEmbedUrlForRegisteredUser](https://docs.aws.amazon.com/quicksight/latest/APIReference/API_GenerateEmbedUrlForRegisteredUser.html))

### 2.3 Embedding SDK — Quick's *own* UI in a browser (not a text API)

`GenerateEmbedUrlForRegisteredUser` (IAM action `quicksight:GenerateEmbedUrlForRegisteredUser`)
returns an **embed URL valid 5 minutes**, opening a **session up to 10 hours**, for embedding a Quick
dashboard, Q search bar, Generative Q&A, console, **or chat agent** in an `<iframe>` (with an
`AllowedDomains` restriction). The reference sample wraps it with Cognito OAuth + OIDC federation and
serves the iframe from CloudFront/API Gateway/Lambda. This surfaces **Quick's UI to browser users** —
it is not a request/response text API and cannot drive a headless stdio agent.
([embed chat agents blog](https://aws.amazon.com/blogs/machine-learning/embed-amazon-quick-suite-chat-agents-in-enterprise-applications/),
[sample repo](https://github.com/aws-samples/sample-quicksuite-chat-embedding),
[GenerateEmbedUrlForRegisteredUser](https://docs.aws.amazon.com/quicksight/latest/APIReference/API_GenerateEmbedUrlForRegisteredUser.html))

### 2.4 MCP — Quick is a **client** that connects *out* to your server (the integration channel)

Verified against AWS's own words: *"The Amazon Quick Suite service includes an **MCP client** that can
be used to securely connect Amazon Quick Suite with AI agents and applications through MCP servers."*
Concretely:

- **You host the MCP server; Quick connects to it.** *"By configuring an MCP integration in Amazon
  Quick, Quick acts as an **MCP client** and connects to your MCP server endpoint to access the tools
  you expose. After that connection is in place, Quick AI agents and automations can invoke your tools
  to retrieve data and run actions in your product."*
- **Transport**: the server must be **reachable from Quick over public HTTPS**, supporting a **remote
  transport — SSE or streamable HTTP** (examples: Atlassian `https://mcp.atlassian.com/v1/sse`, AWS
  Knowledge `https://knowledge-mcp.global.api.aws`).
- **Auth**: **3LO** (user OAuth), **2LO** (service-to-service; used with Bedrock AgentCore Gateway),
  **No Auth** (public servers), and **OAuth 2.0 Dynamic Client Registration** (client IDs without user
  interaction).
- **Managed hosting option**: **Amazon Bedrock AgentCore Gateway / Runtime** can host the MCP (and
  A2A) server for you (2LO), if you prefer not to operate a public endpoint yourself.
  ([MCP blog](https://aws.amazon.com/blogs/machine-learning/connect-amazon-quick-suite-to-enterprise-apps-and-agents-with-mcp/),
  [integrate external tools via MCP](https://aws.amazon.com/blogs/machine-learning/integrate-external-tools-with-amazon-quick-agents-using-model-context-protocol-mcp/),
  [MCP knowledge hub](https://aws-samples.github.io/sample-amazon-quick-suite-knowledge-hub/integration/actions/MCP/custom-mcp-server-agentcore-runtime/))

**Direction confirmed: Quick calls us.** There is no MCP-server mode in which an app "calls into"
Quick's agent.

### 2.5 REST API Connection integration — the lower-ceiling outbound alternative

Quick can call a **custom REST API / web service** as an action connector (OAuth or API-key auth). AWS
notes it "**doesn't support data access or knowledge base creation — it's designed specifically for
task execution and API interactions**." So it can trigger Lark *actions* but is weaker than MCP for
*retrieval*; MCP is the better primary. ([REST API integration](https://docs.aws.amazon.com/quick/latest/userguide/rest-api-integration.html))

### 2.6 A2A (agent-to-agent) — not a Quick-as-callable surface

A2A appears via **Bedrock AgentCore Runtime** (which can host A2A servers on an HTTP/JSON-RPC
interface) and AWS DevOps Agent — i.e., for building agents you *host*, not for invoking a Quick chat
agent from outside. It does not give us "call Quick and get an answer."
([A2A in AgentCore](https://aws.amazon.com/blogs/machine-learning/introducing-agent-to-agent-protocol-support-in-amazon-bedrock-agentcore-runtime/))

---

## 3. Design — `lark-quick-mcp`, a public Lark MCP server for Quick

### 3.1 Shape

A standalone MCP server that exposes a curated **Lark tool catalog** over **streamable HTTP** on a
**public HTTPS** endpoint, protected by **OAuth**. Quick registers it under **Actions → MCP
integration**; Quick's chat agents then call its tools.

```
Amazon Quick chat agent ──(MCP over HTTPS, OAuth)──▶ lark-quick-mcp ──(tenant/user token)──▶ Lark OpenAPI
                                                        │
                                                        └── reuses src/lark-tools/ tool handlers + LarkHttpClient
```

> **This is not an ACP agent preset.** It is a **new, largely independent component** — the
> `bin/agents.ts` preset registry, `spawnAgent`, and the ACP handshake do **not** apply. It reuses the
> *tool implementations* and the Lark client, not the ACP bridge machinery.

### 3.2 Reuse vs. new — be precise about what the existing `src/lark-tools/` gives us

The repo already has a Lark MCP tool server (`src/lark-tools/`, see `docs/lark-mcp-tool-server.md`),
but it is deliberately built for the **opposite** environment — a **loopback (`127.0.0.1`),
in-process** server injected into a **co-located ACP agent subprocess**, addressed by an unguessable
per-chat URL path, with **no auth** and **no public exposure**. Its headline feature — **interactive
tools (`lark_ask_choice` / `lark_ask_text`) that pop a Lark card and await a click on the bound Lark
chat** — depends on there being a live Lark chat + operator, which **does not exist in the Quick
model** (the human is in Quick's UI, not a Lark chat).

| Concern | Existing in-process server (`src/lark-tools/`) | `lark-quick-mcp` (new) |
| --- | --- | --- |
| Reachable by | co-located agent subprocess | **Amazon Quick cloud** |
| Bind / transport | `127.0.0.1` ephemeral, streamable HTTP | **public HTTPS**, streamable HTTP/SSE |
| Auth | per-chat URL token (loopback trust) | **OAuth** (2LO / DCR / 3LO) |
| Chat context | bound to a live Lark chat + operator | **none** — stateless per call |
| Interactive `ask_*` tools | yes (card + WS click) | **no** (no Lark chat to prompt) |
| Read/write Lark tool handlers | ✅ | **reuse** |
| `LarkHttpClient` + name caches | ✅ | **reuse** |

**Reuse**: the tool handler bodies in `src/lark-tools/tools.ts` (e.g. `lark_download_message_file`,
`lark_send_message` logic) and `LarkHttpClient`. **Build new**: the public HTTP transport, OAuth, the
identity/tenant resolution, and a Quick-appropriate catalog (drop the interactive `ask_*` tools). To
keep both servers sharing one catalog, factor the pure handlers into a transport-agnostic module both
can register (a small refactor of `src/lark-tools/tools.ts`).

### 3.3 Tool catalog (Quick-appropriate)

Read/query first (highest value, lowest risk), curated small (a bloated catalog slows the agent):

- `lark_search_docs` / `lark_read_doc` — find and read Docx/Wiki content.
- `lark_query_base` — read Base (Bitable) records / run a view.
- `lark_search_messages` / `lark_list_chat_history` — read IM context (read scopes).
- `lark_get_calendar` — read calendar/free-busy.
- `lark_download_file` — fetch a doc/message attachment (returns an MCP resource / base64).

**v1 ships read tools (on by default) *and* a selected set of write tools (opt-in, off by default)** —
per the locked decision. Writes stay behind explicit configuration because ingested Lark/Quick content
can carry injected instructions (prompt-injection posture, mirrors `architecture-and-scaling-plan.md`
§4.3): `lark_send_message`, `lark_create_doc`, `lark_create_calendar_event`, `lark_upsert_base_record`
— each individually enabled via `QUICK_MCP_TOOLS`, gated by the `QUICK_MCP_ALLOW_WRITES` master switch,
and annotated in their MCP tool descriptions as side-effecting. **No** interactive `ask_*` tools (§3.2).
Each tool wraps `lark-cli` skill semantics / `LarkHttpClient` calls the repo already implements.

### 3.4 Exposure — self-host on a laptop behind a TLS tunnel, host-agnostic for AgentCore later

The bridge today is intentionally **NAT-friendly with no public endpoint** (Lark WebSocket
long-connection). Quick's MCP client, being a cloud service, requires a **publicly reachable HTTPS
URL** — the one architectural tension this integration forces.

**Reality check for "self-host on my laptop".** A laptop is behind NAT with no public IP, no public
DNS name, and no TLS cert for a public hostname — so it **cannot** be a public TLS origin that Quick
reaches *by itself*. It becomes reachable in one of two ways:

- **Tunnel (the practical laptop path, chosen).** Run `lark-quick-mcp` on `127.0.0.1`; put a tunnel in
  front that terminates valid TLS at its edge and forwards to localhost — **Cloudflare Tunnel**
  (stable named hostname, free, no inbound port-forward) or **ngrok**. Quick registers the tunnel's
  `https://…` URL. TLS and public ingress are the tunnel's job; the laptop only runs Node. This is
  "self-hosted" compute with rented ingress — good for development and a single-operator deployment.
- **Router port-forward + DDNS + Let's Encrypt** — a "true" laptop-origin TLS endpoint. Possible but
  fragile (dynamic IP, router control, cert renewal, exposes the laptop directly) — not recommended.

**Design so hosting is a deployment detail, not a rewrite.** `lark-quick-mcp` is a **plain
streamable-HTTP MCP server that terminates nothing and assumes nothing about its ingress** — it reads
`X-Forwarded-*`, binds a configurable host/port, and validates OAuth on its own. That keeps all three
fronts interchangeable behind the *same* server:

| Front (ingress + TLS) | When | Server change |
| --- | --- | --- |
| **Cloudflare Tunnel / ngrok → localhost** | now (laptop dev + single-operator) | none |
| Reverse proxy / ALB / API Gateway HTTP API on a real host | production self-host | none (deploy target only) |
| **Bedrock AgentCore Gateway** (AWS-managed MCP endpoint, 2LO) | later / fallback if laptop-TLS is unworkable | package the same tool handlers behind the Gateway's contract (§2.4) |

**Foundation for AgentCore Gateway (do now, cheap):** keep tool handlers **transport-agnostic**
(§3.2/§5), express the catalog as data (name/description/inputSchema + handler) so it can be
re-registered behind the Gateway, and keep OAuth config abstracted (`2lo` today via the tunnel,
Gateway-issued 2LO later) rather than hard-coded. Then "move to AgentCore Gateway" is a packaging +
deploy task, not a redesign.

### 3.5 Authentication & identity

- **Server auth (Quick → us)**: **OAuth 2LO / client-credentials** is the cleanest fit — Quick
  authenticates to `lark-quick-mcp` as a service. **DCR** if we want Quick to self-register a client.
  **3LO** only if we want per-Quick-user consent (heavier). No-Auth is unacceptable for a public
  endpoint touching Lark data.
- **Lark identity (us → Lark)**: v1 uses the **bot/tenant token** (`tenant_access_token`) — one shared
  service identity. This carries the **same cross-user read-escalation caveat** as
  `architecture-and-scaling-plan.md` §4.2: every Quick user sees whatever the bot can read. Keep Lark
  scopes minimal; put writes behind config. Per-user Lark identity (mapping a Quick user → a Lark
  `user_access_token`) is a later isolation upgrade and requires an OAuth mapping between the two
  directories — treat as Phase 2 (§8 Q4).

### 3.6 Configuration surface

A dedicated config (env / `config.json` block), independent of the ACP bridge's:

| Setting | Meaning |
| --- | --- |
| `QUICK_MCP_PORT` / bind | listen port for the public service (behind TLS termination) |
| `QUICK_MCP_OAUTH_*` | OAuth mode (`2lo`/`dcr`/`3lo`), issuer, audience, JWKS URL, allowed clients |
| `QUICK_MCP_TOOLS` | enabled tool ids (read set on by default; writes opt-in) |
| `QUICK_MCP_ALLOW_WRITES` | master switch for write tools |
| Lark creds/domain | reuse the bridge's existing Lark app credential + `feishu`/`lark` domain config |

Parse with **zod** (`CLAUDE.md` §4/§9); fail fast on missing OAuth config.

### 3.7 Testing

- **Unit** (`src/lark-tools/*.test.ts` extended): each Quick-facing tool handler against a fake
  `LarkHttpClient`; OAuth token validation (accept a valid 2LO token, reject bad `aud`/`iss`/expired);
  zod config parsing.
- **E2E** (`tests/quick-mcp.test.ts`): drive `lark-quick-mcp` over a **real MCP HTTP client** (or the
  **MCP Inspector**) — `initialize`, `tools/list` returns the catalog, a read tool round-trips against
  a fake Lark endpoint, a write tool is blocked when `QUICK_MCP_ALLOW_WRITES=false`, and an
  unauthenticated request is rejected. Extend the existing MCP-HTTP test pattern
  (`docs/lark-mcp-tool-server.md` §7), don't invent a new harness.
- **Manual against Quick**: register the endpoint in Quick (Actions → MCP integration) with OAuth, ask
  the system chat agent to use a Lark tool, verify the round-trip. (Needs the Quick tenant.)

### 3.8 Out of scope for v1

- Interactive Lark cards (`ask_*`) — no bound Lark chat in the Quick model (§3.2).
- Per-Quick-user → per-Lark-user identity mapping (§3.5) — Phase 2.
- Embedding Quick's chat UI in a portal (§2.3) — a *different* deliverable; only if a web portal is
  wanted (§6 Alt-B).
- The `qbusiness` ChatSync ACP adapter — excluded by the "no Q Business" constraint (§6 Alt-D).

---

## 4. Rollout

1. Refactor `src/lark-tools/tools.ts` into **transport-agnostic, data-described handlers** shared by
   the in-process (ACP) server and the new public (Quick) server (§3.2, §3.4 foundation).
2. Implement `lark-quick-mcp` — a plain streamable-HTTP MCP server + OAuth **2LO** validation + the
   **read** tool catalog + unit tests.
3. **Expose from the laptop via a TLS tunnel** (Cloudflare Tunnel / ngrok → `127.0.0.1`, §3.4);
   register the tunnel URL in Quick (**Actions → MCP integration**); verify a round-trip with the
   system chat agent.
4. Add the **selected write tools** behind `QUICK_MCP_ALLOW_WRITES` + per-tool `QUICK_MCP_TOOLS`
   enable (§3.3); E2E test the write-blocked-when-disabled and unauthenticated-rejected paths (§3.7).
5. README (EN/CN): Quick MCP-integration click-path, OAuth 2LO setup, the tunnel steps, tool catalog +
   limitations, the identity caveat.
6. **AgentCore Gateway foundation → migration**: keep the packaging seam from step 1; when
   laptop/tunnel is outgrown (or if it proves unworkable), deploy the same handlers behind Bedrock
   AgentCore Gateway with no redesign (§3.4).
7. Phase 2: per-user Lark identity (§3.5); catalog growth; optionally the embedding-SDK portal
   (Alt-B) if a browser surface is also wanted.

---

## 5. How this fits the existing repo

- **Not an ACP agent.** No `bin/agents.ts` preset, no `spawnAgent`, no ACP handshake — Quick is not an
  ACP agent and cannot be one. `lark-quick-mcp` is a sibling deliverable that **reuses the Lark tool
  layer**, not the agent-bridge layer.
- **Reuses** `LarkHttpClient`, the Lark credential/domain config, and the `src/lark-tools/` handler
  bodies; **adds** a public transport + OAuth.
- **Diverges** from the bridge's no-public-endpoint posture (§3.4) — the one architectural tension to
  accept deliberately.
- The **identity trade-off** is the same one already reasoned about in
  `architecture-and-scaling-plan.md` §4.2 (shared bot identity vs. per-user).

---

## 6. Alternatives considered

- **Alt-A — REST API Connection instead of MCP** (§2.5). Simpler per-action, but "no data access /
  knowledge base" — weaker for retrieval. Use only if MCP is unavailable in the tenant; otherwise MCP
  is strictly better.
- **Alt-B — Embedding SDK portal** (§2.3). If the goal is *a web page showing Quick's chat*, embed via
  `GenerateEmbedUrlForRegisteredUser`. This does **not** involve Lark or this bridge; listed for
  completeness in case a portal is also wanted.
- **Alt-C — Headless-browser automation of the embed URL.** Drive the iframe chat with Playwright and
  scrape replies. **Rejected**: fragile, breaks on UI change, likely against terms, unmaintainable.
- **Alt-D — Add Amazon Q Business and use `ChatSync` (the original ACP-adapter plan).** *Only* if the
  org later onboards Q Business (note: **Q Business closes to new customers 2026-07-31**). This would
  restore the "Quick/Q as the brain behind the Lark bot" topology via a `lark-acp-quick` ACP adapter
  over `@aws-sdk/client-qbusiness`. Out of scope by the current constraint; kept here as the only route
  that preserves the original topology.

---

## 7. Sources

- Quick overview — [product](https://aws.amazon.com/quick/) ·
  [announcement](https://aws.amazon.com/blogs/aws/reimagine-the-way-you-work-with-ai-agents-in-amazon-quick-suite/) ·
  [working with agents](https://docs.aws.amazon.com/quick/latest/userguide/working-with-agents.html) ·
  [use a chat agent](https://docs.aws.amazon.com/quicksuite/latest/userguide/use-agents.html)
- MCP (the integration path) — [connect Quick with MCP](https://aws.amazon.com/blogs/machine-learning/connect-amazon-quick-suite-to-enterprise-apps-and-agents-with-mcp/) ·
  [integrate external tools via MCP](https://aws.amazon.com/blogs/machine-learning/integrate-external-tools-with-amazon-quick-agents-using-model-context-protocol-mcp/) ·
  [custom MCP server on AgentCore](https://aws-samples.github.io/sample-amazon-quick-suite-knowledge-hub/integration/actions/MCP/custom-mcp-server-agentcore-runtime/)
- REST API connection — [REST API integration](https://docs.aws.amazon.com/quick/latest/userguide/rest-api-integration.html)
- Embedding (not our path) — [embed chat agents blog](https://aws.amazon.com/blogs/machine-learning/embed-amazon-quick-suite-chat-agents-in-enterprise-applications/) ·
  [sample repo](https://github.com/aws-samples/sample-quicksuite-chat-embedding) ·
  [GenerateEmbedUrlForRegisteredUser](https://docs.aws.amazon.com/quicksight/latest/APIReference/API_GenerateEmbedUrlForRegisteredUser.html) ·
  [Quick embedding APIs](https://docs.aws.amazon.com/quicksuite/latest/userguide/embedded-analytics-api.html)
- A2A — [A2A in Bedrock AgentCore](https://aws.amazon.com/blogs/machine-learning/introducing-agent-to-agent-protocol-support-in-amazon-bedrock-agentcore-runtime/)

---

## 8. Decisions & remaining questions

**Resolved (2026-07-21):**
1. **Topology** — proceed with the inversion: Quick → Lark tools via MCP; Quick's chat is the surface. ✅
2. **Hosting** — self-host `lark-quick-mcp` on the operator's laptop behind a **TLS tunnel**
   (Cloudflare Tunnel / ngrok — §3.4), architected host-agnostic so **Bedrock AgentCore Gateway** is a
   later deploy step (or the fallback if laptop-TLS is unworkable). ✅
3. **Tool scope** — **read tools + a selected set of write tools** (writes opt-in, off by default). ✅

**Still open (proposed defaults; flag if you disagree):**
4. **Identity (default: shared bot/tenant token for v1).** All Quick users would share the bot's Lark
   read/write access (§3.5 / `architecture-and-scaling-plan.md` §4.2). Per-user Lark identity is
   Phase-2-shaped. Proceeding with the shared-identity default unless you need per-user isolation now.
5. **OAuth issuer for 2LO.** Which token issuer validates Quick→server calls — a self-issued
   client-credentials setup, or the tunnel/Gateway-provided one? Affects the `QUICK_MCP_OAUTH_*` config
   (§3.6); resolve at implementation time.
6. **Which specific write tools first.** From the §3.3 candidate set (`lark_send_message`,
   `lark_create_doc`, `lark_create_calendar_event`, `lark_upsert_base_record`) — confirm the initial
   opt-in list.
</content>
