# Changelog

All notable changes to `lark-acp-bridge` are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

Phase 1 — harden the self-hostable, org-wide assistant (see
`docs/architecture-and-scaling-plan.md`).

### Added

- **Access control (private-by-default).** Two enforcement points:
  - _Message intake_ — owner / admin / user / group allowlists gate every
    inbound message; non-allowed senders are silently ignored. The first user
    to DM the bot claims ownership (or pin it with `--owner` /
    `access.ownerOpenId` / `LARK_ACP_OWNER`).
  - _Card actions_ — permission cards are now bound to their originating
    operator; a non-operator (non-admin) click is rejected and the tool does
    not run, closing the hole where any group member could approve another
    user's tool call.
  - In-chat management for owner/admin: `/access`, `/invite user|admin @…`,
    `/invite group`, `/remove …`, `/mention on|off`. State persists atomically
    under `dataDir` and takes effect on the next message without a restart.
    Every access decision and mutation emits an `audit`-tagged log line.
  - Disable with `--no-access-control` / `access.enabled=false`.
- **`lark-cli` identity policy + prompt-context injection.** `bot-only`
  (default) vs `user-default`, exposed to the agent subprocess via a
  documented `LARK_ACP_*` env contract and a managed `dataDir/lark-cli` config
  directory. A structured chat/sender context block is prepended to prompts.
  Credential injection into the agent env is opt-in
  (`--inject-lark-credentials`). Configure with `--identity` /
  `identity.policy` / `LARK_ACP_IDENTITY`.
- **Operability commands.** `/help`, `/status` (role, agent, session, WS
  connection state, identity policy, permission mode), and `/config`
  (owner/admin only).
- **Cold-start optimization — `lark-acp prepare`.** Pre-installs `npx`-based
  agent shims into `dataDir/shims`; `proxy` then launches them directly with
  `node` (no `npx` resolution, no network on spawn, version pinned by the
  prepared install), falling back to `npx` when unprepared. No new hard
  dependencies, and permission cards are unaffected (same shim binary).
- **OS service management — `lark-acp service <install|uninstall|status>`.**
  Generates a systemd user unit (Linux), a launchd LaunchAgent (macOS), or a
  Task Scheduler task (Windows), writes the unit file, and prints the exact
  activation commands. Restart-on-failure and run-at-login are built in.
- **WebSocket keepalive / reconnect** for unattended operation: configures the
  SDK's liveness watchdog (`runtime.pingTimeoutSeconds`, default 60s),
  handshake timeout (`runtime.handshakeTimeoutMs`, default 15000ms), and
  auto-reconnect, with escalating reconnect logging and connection state in
  `/status`.

### Phase 2 groundwork (non-breaking, single-tenant defaults)

- **Explicit tenant id.** All logs and audit records are keyed by `tenantId`
  (default `"default"`; set via `tenantId` / `LARK_ACP_TENANT_ID`), so a
  hosted deployment can run one bridge per tenant without a rewrite. Shown in
  `/status`.
- **Transport seam.** Inbound events arrive through a `LarkTransport` built by
  a `LarkTransportFactory` (default: the WebSocket long connection). A
  hosted/ISV deployment can inject a webhook receiver via `transportFactory`
  without touching the bridge.
- **Pluggable audit sink.** Security events flow through an `AuditLogger`
  (default `LoggerAuditLogger`, tenant-tagged) instead of ad-hoc log calls, so
  they can be routed to a separate, retained per-tenant sink.

### Changed

- Build vs. lint/typecheck configs split: `tsconfig.build.json` emits the
  library + bin (excluding tests), while `tsconfig.json` includes tests for
  the editor / ESLint project service / `tsc --noEmit`.

### Library API

- New exports: `AccessControl`, `FileAccessStore`, `Identity`,
  `LarkWsKeepaliveOptions`, `AuditLogger`, `LoggerAuditLogger`,
  `LarkTransport`, `LarkTransportFactory`, `LarkTransportOptions`,
  `LarkConnectionStatus`, and their types. `LarkBridge` accepts optional
  `accessControl`, `identity`, `lark.keepalive`, `tenantId`,
  `transportFactory`, and `auditLogger` — all omittable, so existing
  programmatic consumers are unaffected.
