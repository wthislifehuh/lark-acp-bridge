# lark-acp

[![npm version](https://img.shields.io/npm/v/@4t145/lark-acp.svg)](https://www.npmjs.com/package/@4t145/lark-acp)
[![npm downloads](https://img.shields.io/npm/dm/@4t145/lark-acp.svg)](https://www.npmjs.com/package/@4t145/lark-acp)
[![node version](https://img.shields.io/node/v/@4t145/lark-acp.svg)](https://www.npmjs.com/package/@4t145/lark-acp)
[![license](https://img.shields.io/npm/l/@4t145/lark-acp.svg)](./LICENSE)

**English** | **[中文](docs/README_CN.md)**

**Turn your Feishu / Lark bot into an AI coding agent.** `lark-acp` bridges a [Feishu/Lark](https://open.larksuite.com/) bot to **any AI agent that speaks the [Agent Client Protocol (ACP)](https://agentcommunicationprotocol.dev/)** — Claude Code, Kiro CLI, OpenAI Codex, Google Gemini CLI, GitHub Copilot CLI, OpenCode, Amazon Q Developer CLI, or your own ACP server.

You send a message in Feishu/Lark; the agent runs on your machine; its thinking, tool calls, and answer stream into a single interactive Feishu card. Tool-call authorization, task interruption, and cross-restart session resume are all handled inside the card.

> 💖 Found this project useful — or just mildly interesting? A ⭐ Star in the top-right corner is the most direct encouragement you can give the author.

> ⚠️ **WIP**: still iterating — CLI options and config fields may change before 1.0.

For real-world use we strongly recommend pairing this with the [Lark CLI](https://github.com/larksuite/cli) and its skills — the bridge injects chat context (chat id, sender name, group name) into the prompt, so the agent can chain into all kinds of Lark operations through the Lark CLI.

<p align="center">
  <img src="docs/mock-example.png" alt="lark-acp demo — an AI agent streaming thoughts, tool calls and results into an interactive Feishu/Lark card" width="640">
</p>

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference) — [presets](#built-in-agent-presets) · [options](#global-options) · [in-chat commands](#in-chat-commands) · [config file](#configuration-file) · [env vars](#environment-variables)
- [Connecting specific agents](#connecting-specific-agents) — [Kiro](#connecting-kiro) · [Gemini](#connecting-gemini) · [Amazon Q](#connecting-amazon-q)
- [Feishu/Lark developer console setup](#feishulark-developer-console-setup)
- [Deployment](#deployment)
- [Using as a library](#using-as-a-library)
- [Troubleshooting](#troubleshooting)

## How it works

```
 Feishu / Lark cloud                        Your machine
┌─────────────────────┐                ┌─────────────────────────────────────────┐
│  user message       │   WebSocket    │  lark-acp bridge                        │
│  card button click  │ ◄────────────► │   ├─ interpreter   (msg → ACP blocks)   │
│                     │   (long conn,  │   ├─ presenter     (ACP → Lark cards)   │
│  interactive card   │    no public   │   ├─ session store (resume across       │
│  (streamed updates) │    IP needed)  │   │                 restarts)           │
└─────────────────────┘                │   └─ ACP client ──► agent subprocess    │
                                       │       JSON-RPC 2.0    (claude / kiro    │
                                       │       over stdio       / codex / ...)   │
                                       └─────────────────────────────────────────┘
```

- **No public endpoint required** — events arrive over Lark's persistent WebSocket connection, so the bridge runs fine behind NAT, on a laptop, or in a container.
- **One card per task** — thoughts, tool calls, and the final answer are merged into a single continuously-updated card instead of flooding the chat (especially group chats) with messages.
- **Per-tool permission cards** — when the agent wants to run a tool, the bridge pops an authorization card and pauses the agent until you answer (unanswered requests auto-cancel after 5 minutes; policy configurable via [`--permission-mode`](#global-options)).
- **Session persistence** — chat → session mappings are stored on disk; agents that support ACP `session/load` / resume pick up right where they left off after a bridge restart.
- **Concurrent chats** — each Feishu chat gets its own agent session, with idle eviction (`--idle-timeout`, `--max-chats`).

## Quick start

**Prerequisites**: Node.js ≥ 20, a Feishu/Lark custom app ([setup below](#feishulark-developer-console-setup)), and at least one agent CLI installed and authenticated.

```bash
# 1. Write your app credentials (one-time)
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/lark-acp"
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/lark-acp/config.json" <<'EOF'
{
  "credentials": {
    "appId": "cli_a1b2c3d4e5f60001",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "domain": "feishu"
  }
}
EOF
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/lark-acp/config.json"

# 2. Start the bridge
npx -y @4t145/lark-acp proxy --agent claude
```

Then find the bot in Feishu/Lark — DM it, or add it to a group and @mention it.

> ⚠️ **Region matters**: if your app was created on **Lark International** (`open.larksuite.com`), set `"domain": "lark"` — otherwise the handshake is rejected with error code `1000040351` ("Incorrect domain name"). The default `feishu` is for apps on `open.feishu.cn`.

To build from source instead:

```bash
bun install        # or: npm install
bun run build      # or: npm run build
node dist/bin/lark-acp.js --help
```

## CLI reference

### Command format

```
lark-acp [global-options] proxy --agent <preset> [-- <extra-args>...]
lark-acp [global-options] proxy -- <agent-cmd> [agent-args...]
lark-acp agents
lark-acp help
lark-acp version
```

Two ways to pick an agent:

- **`--agent <preset>`** — use a built-in preset (most common). Run `lark-acp agents` for the full list.
- **`-- <agent-cmd>`** — a raw command; everything after `--` is forwarded to the agent verbatim.

They compose: `proxy --agent claude -- --debug` appends `--debug` to the preset's args before launching.

Global options must come before the `proxy` subcommand (`--domain` is also accepted after `proxy` for convenience).

### Built-in agent presets

| Preset         | Description                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`       | Claude Code via Zed's ACP adapter. Run `claude` in a terminal once first to log in.                                                                               |
| `claude-agent` | Claude Agent SDK adapter — direct Anthropic API. Needs `ANTHROPIC_API_KEY`.                                                                                       |
| `codex`        | OpenAI Codex via Zed's ACP adapter.                                                                                                                               |
| `copilot`      | GitHub Copilot CLI (native `--acp`).                                                                                                                              |
| `gemini`       | Google Gemini CLI (experimental `--acp`). Personal "Sign in with Google" was discontinued — use an API key instead, see [Connecting Gemini](#connecting-gemini).  |
| `opencode`     | OpenCode. Assumes `opencode` is on `$PATH`.                                                                                                                       |
| `kiro`         | Kiro CLI (native ACP via `kiro-cli acp`). Assumes `kiro-cli` is on `$PATH` and logged in. See [Connecting Kiro](#connecting-kiro).                                |
| `q`            | Amazon Q Developer CLI via the bundled adapter (`q` has no native ACP). Needs `q` on `$PATH` and `q login` done. See [Connecting Amazon Q](#connecting-amazon-q). |
| `mock`         | Built-in scripted agent (thoughts / tool calls / permission cards / Markdown) for local end-to-end debugging.                                                     |

Agents not covered by a preset can be launched as a raw command:

```bash
lark-acp proxy -- node ./my-acp-server.js --port 9000
```

You can also persist your own presets in the config file's `agents` field (see [Configuration file](#configuration-file)).

### Global options

| Option                  | Description                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--cwd <dir>`           | Agent working directory (default: current directory)                                                                                                    |
| `--config <path>`       | Override the config file path                                                                                                                           |
| `--data-dir <dir>`      | Override the session-storage directory                                                                                                                  |
| `--domain <region>`     | Deployment region: `feishu` (default, `open.feishu.cn`) / `lark` (International, `open.larksuite.com`), or a full base URL for a self-hosted deployment |
| `--idle-timeout <min>`  | Release a chat's agent session after N idle minutes (`0` = never, default 1440)                                                                         |
| `--max-chats <n>`       | Maximum concurrent chat sessions (default 10)                                                                                                           |
| `--hide-thoughts`       | Don't render the agent's thinking process in the card                                                                                                   |
| `--hide-tools`          | Don't render tool calls in the card                                                                                                                     |
| `--hide-cancel-button`  | Don't render the "cancel current task" button at the bottom of the card                                                                                 |
| `--permission-mode <m>` | Tool authorization policy: `alwaysAsk` (default, pops a card for the user) / `alwaysAllow` (auto-approve) / `alwaysDeny` (auto-reject)                  |
| `-h`, `--help`          | Show help                                                                                                                                               |
| `-v`, `--version`       | Show version                                                                                                                                            |

### In-chat commands

Send these directly to the bot (in a group, @mention the bot first):

| Command                               | Effect                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `/cancel` / `/stop` / `取消` / `停止` | Interrupt the current task (the agent process stays alive; the session continues) |
| `/new` / `/restart`                   | Reset the session — the next message starts a brand-new agent session             |

### Configuration file

The CLI reads one config file (default `~/.config/lark-acp/config.json`) holding credentials and runtime defaults. Precedence: **CLI flag > environment variable > config file > built-in default**.

All fields are optional:

```jsonc
{
  "credentials": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    // Deployment region: feishu (default) / lark (International),
    // or a full base URL for a self-hosted deployment
    "domain": "feishu",
  },
  "dataDir": "./var/lark-acp",
  "runtime": {
    "cwd": "/work/project",
    "idleTimeoutMinutes": 1440,
    "maxChats": 10,
    "hideThoughts": false,
    "hideTools": false,
    "hideCancelButton": false,
    "permissionMode": "alwaysAsk",
  },
  "agents": {
    // Patch an existing built-in preset — only write the fields you change
    "claude": {
      "env": { "ANTHROPIC_BASE_URL": "https://my-proxy.example.com" },
    },
    // Add your own preset — must define both `label` and `command`
    "my-agent": {
      "label": "My ACP Agent",
      "command": "node",
      "args": ["./my-agent.js", "--acp"],
      "description": "Locally developed agent",
      "env": { "FOO": "bar" },
    },
  },
}
```

`lark-acp agents` lists every preset available under the current config, tagged with its source (`[built-in]` / `[user]` / `[overridden]`).

### Environment variables

| Variable                   | Effect                             |
| -------------------------- | ---------------------------------- |
| `LARK_ACP_APP_ID`          | Overrides `credentials.appId`      |
| `LARK_ACP_APP_SECRET`      | Overrides `credentials.appSecret`  |
| `LARK_ACP_DOMAIN`          | Overrides `credentials.domain`     |
| `LARK_ACP_CONFIG`          | Overrides the config file path     |
| `LARK_ACP_DATA_DIR`        | Overrides the session-storage dir  |
| `LARK_ACP_PERMISSION_MODE` | Overrides `runtime.permissionMode` |

## Connecting specific agents

### Connecting Kiro

Kiro CLI (AWS's official successor to Amazon Q Developer CLI) supports ACP natively via `kiro-cli acp` — no adapter needed. Install [Kiro CLI](https://kiro.dev/docs/cli/), log in once, then:

```bash
lark-acp proxy --agent kiro
```

You get the full experience: per-tool permission cards, the thought/tool timeline, and session resume across bridge restarts (Kiro advertises ACP `loadSession`).

### Connecting Gemini

On 2026-06-18 Google discontinued the free "Sign in with Google" OAuth login of Gemini CLI for **personal accounts** (Gemini Code Assist for individuals / Google AI Pro / Ultra), steering users to [Antigravity](https://antigravity.google) instead. Picking "1. Sign in with Google" on first run of `gemini` now fails with:

```text
Failed to sign in. This client is no longer supported for Gemini Code Assist
for individuals. To continue using Gemini, please migrate to the Antigravity
suite of products: https://antigravity.google
```

The Gemini CLI itself (Apache-2.0, still maintained) keeps working with a **Gemini API key** — no Antigravity migration needed. Since this project launches `gemini` as a subprocess (`npx -y @google/gemini-cli --experimental-acp`), **put the API key in the config file** so the subprocess authenticates non-interactively:

**1. Get an API key**: open [Google AI Studio](https://aistudio.google.com/apikey), sign in, and click **Create API key** (the free tier covers the Flash models; keys look like `AIza...`).

**2. Write it into `agents.gemini.env`** (patching the built-in `gemini` preset):

```jsonc
{
  "agents": {
    "gemini": {
      // Inject the API key so the bridged subprocess skips interactive OAuth
      "env": { "GEMINI_API_KEY": "AIza..." },
    },
  },
}
```

With `GEMINI_API_KEY` set, `gemini` picks API-key auth automatically and never shows the login menu:

```bash
lark-acp proxy --agent gemini
```

> **Login menu still appears on first run?** Some versions still show the auth menu on a brand-new machine. Run `gemini` **manually** in a terminal once, select **2. Use Gemini API Key** with the arrow keys, and paste the key — the choice persists to `~/.gemini/settings.json`, after which the bridged subprocess won't prompt again.

**Notes**:

- `GOOGLE_API_KEY` and `GEMINI_API_KEY` are equivalent; when both are set the former wins.
- Free-tier rate limits are low (roughly a few hundred requests/day on the Flash models). A **Google One / AI Pro subscription does not automatically unlock paid API quota** — if you hit a 429 with `limit: 0`, attach a billing account in Google Cloud.
- Enterprises / teams can use **3. Vertex AI** from the auth menu instead (unaffected by the shutdown); set `GOOGLE_GENAI_USE_VERTEXAI=true` plus `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`.

### Connecting Amazon Q

Amazon Q Developer CLI (`q`) has **no native ACP** — AWS moved that investment to its successor, Kiro CLI (which ships native ACP via `kiro-cli acp`, see the `kiro` preset above), and stated they won't implement it for `q` ([feature request #2703](https://github.com/aws/amazon-q-developer-cli/issues/2703)). This project therefore ships a lightweight adapter, `lark-acp-q`, that translates ACP into `q chat` invocations so the classic `q` can still plug in.

**Usage** (make sure `q` is on `$PATH` and `q login` is done):

```bash
lark-acp proxy --agent q
```

**How it works**: each Feishu chat owns one adapter process, which maintains that chat's transcript in memory. On every message, the adapter replays the history as context into a fresh `q chat --no-interactive --trust-all-tools` invocation, streams the ANSI-stripped stdout back as `agent_message_chunk`s, then appends the turn to the transcript. This keeps concurrent Feishu chats isolated even when they share one `cwd` (`q`'s own `--resume` is keyed by directory and would cross-contaminate them, so it's not used). Transcripts are persisted per sessionId, so the bridge can restore them via `session/load` after a restart.

**Two inherent limitations** (capability boundaries of `q` itself, not bugs):

1. Non-interactive `q` must trust tools up front (otherwise it blocks waiting for TTY input), so **the `q` route cannot pop per-tool authorization cards** — tools are auto-approved. If you need per-tool authorization, use a native-ACP agent like `kiro` / `claude` instead.
2. `q chat` emits unstructured text (no JSON event stream), so **thoughts and tool calls are not split out** into the card timeline — the answer streams as one message.

**Optional environment variables** (set them in the config file under `agents.q.env`, or export directly):

| Variable                  | Default                      | Description                                                                                                                             |
| ------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Q_ACP_BIN`               | `q`                          | Amazon Q executable name / absolute path                                                                                                |
| `Q_ACP_MODEL`             | —                            | Passed through to `q chat --model`                                                                                                      |
| `Q_ACP_AGENT`             | —                            | Passed through to `q chat --agent` (Amazon Q custom agent / profile)                                                                    |
| `Q_ACP_TRUST_TOOLS`       | — (i.e. `--trust-all-tools`) | Set to a comma-separated list to use `--trust-tools` with only those                                                                    |
| `Q_ACP_WRAP`              | `never`                      | Passed through to `q chat --wrap`; set to an empty string to omit it                                                                    |
| `Q_ACP_EXTRA_ARGS`        | —                            | Extra args appended to `q chat` (split on whitespace; quoted args unsupported)                                                          |
| `Q_ACP_DATA_DIR`          | `~/.lark-acp/q-sessions`     | Transcript storage directory                                                                                                            |
| `Q_ACP_MAX_HISTORY`       | `24`                         | Max history messages replayed per invocation                                                                                            |
| `Q_ACP_MAX_HISTORY_CHARS` | `24000`                      | Character budget for replayed history — the whole input travels as a single argv element, so it must stay within OS command-line limits |

Example — pin the model and only trust read-only tools:

```jsonc
{
  "agents": {
    "q": {
      "env": {
        "Q_ACP_MODEL": "claude-sonnet-4",
        "Q_ACP_TRUST_TOOLS": "fs_read",
      },
    },
  },
}
```

> **Windows note**: the Amazon Q CLI itself does not run natively on Windows — it needs WSL / Linux / macOS. On a Windows host, run the whole bridge inside WSL (`lark-acp proxy --agent q`), where `q` is installed and logged in.

**Testing without a real `q`**: the repo's test suite drives the adapter end-to-end over real ACP against a fake `q` — run `npm test` (builds first, then vitest: unit tests for the adapter core plus a blackbox e2e in `tests/`).

> **Want per-tool authorization and the full thought/tool timeline?** Kiro CLI is Amazon Q's official successor with native ACP — just use `--agent kiro` (see <https://kiro.dev/docs/cli/acp/>).

## Feishu/Lark developer console setup

Create a **custom app** on the [Feishu Open Platform](https://open.feishu.cn/app) (International: [Lark Developer](https://open.larksuite.com/app)), then configure three things — **permissions**, **events**, and **callbacks** — and publish a version.

### 1. Add permissions

Go to _Permissions & Scopes → Batch import/export scopes → Import_, paste this JSON, and save:

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:message:update",
      "im:message.reactions:write_only",
      "im:resource",
      "im:chat:readonly",
      "cardkit:card:write",
      "contact:user.base:readonly"
    ],
    "user": []
  }
}
```

What each scope is for:

| Scope                                   | Purpose                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `im:message` / `im:message:send_as_bot` | Reply to user messages as the bot                                        |
| `im:message.group_msg`                  | Receive messages in group chats                                          |
| `im:message.p2p_msg:readonly`           | Receive messages in direct (P2P) chats                                   |
| `im:message:readonly`                   | Fetch message context (@mention resolution, rich-text expansion)         |
| `im:message:update`                     | Update interactive cards (streaming thoughts / tool calls / final state) |
| `im:message.reactions:write_only`       | Add / remove emoji reactions to mark task progress                       |
| `im:resource`                           | Download user-uploaded image / file binaries (by `message_id`)           |
| `im:chat:readonly`                      | Read group info (injected into prompt context: group name, group id)     |
| `cardkit:card:write`                    | Send / patch v2 interactive cards                                        |
| `contact:user.base:readonly`            | Read user names (injected into prompt context: sender name)              |

### 2. Add the event

Under _Events & Callbacks → Event Configuration_, switch the **subscription mode** to **Receive events through persistent connection** (no callback URL needed). Then add this one event, subscribing as the **app identity**:

| Event           | event_type              | Purpose                              |
| --------------- | ----------------------- | ------------------------------------ |
| Receive message | `im.message.receive_v1` | Every user message enters the bridge |

### 3. Add the callback

On the same page, in the "card callback" section below, add:

| Callback                | event_type            | Purpose                                                      |
| ----------------------- | --------------------- | ------------------------------------------------------------ |
| Card action interaction | `card.action.trigger` | User clicks a card button (permission options / cancel task) |

### 4. Publish a version

_Version Management & Release → Create version_, fill in the details, and submit for review / release. Choose the **app availability scope** as needed — only users inside it can find and chat with the bot.

### 5. Go

Put the `App ID` / `App Secret` into `config.json` (or the `LARK_ACP_APP_ID` / `LARK_ACP_APP_SECRET` environment variables) and run:

```bash
lark-acp proxy --agent claude
```

Then search for the bot in Feishu/Lark, DM it, or add it to a group and message it.

## Deployment

### Full config example

Persist your usual defaults in the file so the command line shrinks to `proxy --agent`:

```jsonc
{
  "credentials": {
    "appId": "cli_a1b2c3d4e5f60001",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    // Apps on Lark International (open.larksuite.com): use "lark"
    "domain": "feishu",
  },
  "runtime": {
    "cwd": "/srv/projects/main",
    "idleTimeoutMinutes": 60,
    "maxChats": 20,
    "hideThoughts": true,
  },
}
```

CLI flags temporarily override same-named file entries.

### systemd

`lark-acp` is a foreground process — put it under any process manager:

```ini
[Service]
Environment=LARK_ACP_APP_ID=cli_a1b2c3d4e5f60001
Environment=LARK_ACP_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ExecStart=/usr/local/bin/lark-acp --cwd /srv/projects/main proxy --agent claude
Restart=on-failure
```

### Quick examples

```bash
# 1. Claude Code (most common) — sessions persist across restarts
lark-acp proxy --agent claude

# 2. Kiro CLI (native ACP, Amazon Q's official successor)
lark-acp proxy --agent kiro

# 3. OpenCode, pointing the working directory at a specific project
lark-acp --cwd /work/project proxy --agent opencode

# 4. GitHub Copilot CLI, with thought output hidden
lark-acp --hide-thoughts proxy --agent copilot

# 5. Auto-approve all tool calls (trusted sandbox)
lark-acp --permission-mode alwaysAllow proxy --agent claude

# 6. Your own ACP server
lark-acp proxy -- node ./my-acp-server.js --port 9000
```

## Using as a library

The package also exports a programmatic API for building on top of:

```ts
import { LarkBridge, FileSessionStore } from "@4t145/lark-acp";

const bridge = new LarkBridge({
  lark: { appId: "cli_...", appSecret: "...", domain: "lark" },
  agent: {
    command: "kiro-cli",
    args: ["acp"],
    cwd: "/work/project",
    permissionMode: "alwaysAsk",
  },
  session: { idleTimeoutMs: 60 * 60_000, maxConcurrentChats: 20 },
  sessionStore: new FileSessionStore("./var/lark-acp"),
});

await bridge.start();
// ... later: await bridge.stop();
```

Main exports:

- `LarkBridge` — the orchestrator; one instance per process.
- `LarkPresenter` / `LarkCardPresenter` — the pluggable UI surface (swap in your own card rendering).
- `SessionStore` / `FileSessionStore` — persistent chat → session mapping.
- `LarkLogger` / `createPinoLogger` — structured logging.
- `LarkHttpClient`, `LARK_DOMAINS`, `resolveLarkDomain` — Lark HTTP client and region helpers.

## Troubleshooting

**`[ws] code: 1000040351, Incorrect domain name`** — your app lives on Lark International (`open.larksuite.com`) but the bridge is connecting to Feishu (the default). Set `--domain lark`, `credentials.domain: "lark"`, or `LARK_ACP_DOMAIN=lark`. (The reverse also holds: a Feishu app with `domain: "lark"` fails the same way.)

**`Failed to initialize agent (...). Is the agent installed?`** — the agent subprocess didn't complete the ACP handshake. The error includes the agent's recent stderr; the usual causes are the CLI not being installed / not on `$PATH`, or not logged in yet. Run the preset's command by hand (e.g. `kiro-cli acp`, `npx -y @zed-industries/claude-code-acp`) to see the raw failure.

**Gemini: `Failed to sign in. This client is no longer supported...`** — Google discontinued personal-account OAuth for Gemini CLI; switch to an API key as described in [Connecting Gemini](#connecting-gemini).

**Bot doesn't respond in Feishu** — check, in order: the app version is published and you're inside its availability scope; the event subscription mode is **persistent connection** with `im.message.receive_v1` added; all [permissions](#1-add-permissions) are imported and approved.

## Similar projects

1. A Go implementation, also quite complete: <https://github.com/ri-char/Lark-ACP>
2. Another Node implementation this project was refactored from: <https://github.com/JiaqiZhang-Dev/lark-acp>

### What this implementation does differently

1. A proxy-level `permissionMode` setting, born out of production experience.
2. Multiple messages merged into a single card — no message bombing in group chats.
3. Shipped as a library, ready for second-stage development.

---

## References

- ACP protocol: <https://agentcommunicationprotocol.dev/core-concepts/architecture>
- Feishu/Lark Open Platform: <https://open.larksuite.com/document/server-docs/getting-started/getting-started>

License: MIT
