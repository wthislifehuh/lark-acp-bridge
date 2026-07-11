#!/usr/bin/env node
/**
 * `lark-acp` — bridge a Lark bot to any ACP-compatible AI agent.
 *
 * Synopsis:
 *
 *     lark-acp [global-options] proxy -- <agent-cmd> [agent-args...]
 *
 * The CLI is a thin wrapper around {@link LarkBridge}. It reads a
 * general config file (credentials + runtime defaults), merges in
 * environment variables and command-line overrides, then spawns the
 * agent subprocess specified after `proxy --` and pipes Lark traffic
 * through it.
 *
 * Precedence (highest first):
 *
 *   1. CLI flags
 *   2. Environment variables (LARK_ACP_*)
 *   3. Config file (`config.json`)
 *   4. Built-in defaults
 *
 * See README.md for the full reference.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { createRequire } from "node:module";
import {
  LarkBridge,
  FileSessionStore,
  createPinoLogger,
  PERMISSION_MODES,
  LARK_DOMAINS,
  DEFAULT_LARK_DOMAIN,
  isLarkDomainName,
} from "../src/index.js";
import type { LarkLogger, PermissionMode, LarkDomainName } from "../src/index.js";
import { buildRegistry, type Registry, type UserPresetPatch } from "./agents.js";

// Resolved from dist/bin/lark-acp.js, so the package.json sits two levels up.
const { version: VERSION } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

const APP_NAME = "lark-acp";
const CONFIG_FILE = "config.json";

const ENV_APP_ID = "LARK_ACP_APP_ID";
const ENV_APP_SECRET = "LARK_ACP_APP_SECRET";
const ENV_DOMAIN = "LARK_ACP_DOMAIN";
const ENV_CONFIG = "LARK_ACP_CONFIG";
const ENV_DATA_DIR = "LARK_ACP_DATA_DIR";
const ENV_PERMISSION_MODE = "LARK_ACP_PERMISSION_MODE";

const DEFAULT_IDLE_TIMEOUT_MINUTES = 1440;
const DEFAULT_MAX_CHATS = 10;
const DEFAULT_PERMISSION_MODE: PermissionMode = "alwaysAsk";

// ---------- paths ---------------------------------------------------------

/** $XDG_CONFIG_HOME/lark-acp, falling back to ~/.config/lark-acp. */
function defaultConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), ".config", APP_NAME);
}

/** $XDG_DATA_HOME/lark-acp, falling back to ~/.local/share/lark-acp. */
function defaultDataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg && xdg.length > 0) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), ".local", "share", APP_NAME);
}

function resolveConfigPath(override: string | undefined): string {
  if (override) return path.resolve(override);
  const fromEnv = process.env[ENV_CONFIG];
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.join(defaultConfigDir(), CONFIG_FILE);
}

function envDataDirOverride(): string | undefined {
  const fromEnv = process.env[ENV_DATA_DIR];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

// ---------- config file schema -------------------------------------------

type FileCredentials = {
  readonly appId?: string;
  readonly appSecret?: string;
  /** Deployment region name or custom base URL; see {@link validateDomain}. */
  readonly domain?: string;
};

type FileRuntime = {
  readonly cwd?: string;
  readonly idleTimeoutMinutes?: number;
  readonly maxChats?: number;
  readonly hideThoughts?: boolean;
  readonly hideTools?: boolean;
  readonly hideCancelButton?: boolean;
  readonly permissionMode?: PermissionMode;
};

type FileConfig = {
  readonly credentials: FileCredentials;
  readonly dataDir?: string;
  readonly runtime: FileRuntime;
  readonly agents: Readonly<Record<string, UserPresetPatch>>;
};

const EMPTY_FILE_CONFIG: FileConfig = { credentials: {}, runtime: {}, agents: {} };

class CliError extends Error {}

function asStringOpt(label: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CliError(`config: ${label} must be a string`);
  return value;
}

function asBoolOpt(label: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new CliError(`config: ${label} must be a boolean`);
  return value;
}

function asNonNegIntOpt(label: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new CliError(`config: ${label} must be a non-negative integer`);
  }
  return value;
}

function asPositiveIntOpt(label: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new CliError(`config: ${label} must be a positive integer`);
  }
  return value;
}

function asObjectOpt(label: string, value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`config: ${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asPermissionModeOpt(label: string, value: unknown): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isPermissionMode(value)) {
    throw new CliError(`${label} must be one of: ${PERMISSION_MODES.join(" | ")}`);
  }
  return value;
}

function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Accept a deployment region name (`"feishu"` | `"lark"`) or a full custom
 * base URL (for private / on-prem Lark deployments), returning the value
 * unchanged. Anything else is rejected.
 *
 * @throws {CliError} when `value` is neither a known region nor a URL.
 */
function validateDomain(label: string, value: string): LarkDomainName | string {
  if (isLarkDomainName(value)) return value;
  if (isHttpUrl(value)) return value;
  throw new CliError(
    `${label} must be one of: ${LARK_DOMAINS.join(" | ")}, or an http(s) base URL (got: ${value})`,
  );
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "https:" || protocol === "http:";
}

/**
 * Read and validate the JSON config file if present.
 *
 * @throws {CliError} when the file exists but is malformed.
 */
function readConfigFile(filePath: string): FileConfig {
  if (!fs.existsSync(filePath)) return EMPTY_FILE_CONFIG;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new CliError(`failed to read config file ${filePath}: ${formatError(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`config file ${filePath} is not valid JSON: ${formatError(err)}`);
  }
  const root = asObjectOpt("(root)", parsed);
  if (!root) throw new CliError(`config file ${filePath} must contain a JSON object`);

  const credentialsObj = asObjectOpt("credentials", root["credentials"]) ?? {};
  const runtimeObj = asObjectOpt("runtime", root["runtime"]) ?? {};

  const appIdField = asStringOpt("credentials.appId", credentialsObj["appId"]);
  const appSecretField = asStringOpt("credentials.appSecret", credentialsObj["appSecret"]);
  const domainField = asStringOpt("credentials.domain", credentialsObj["domain"]);
  const credentials: FileCredentials = {
    ...(appIdField !== undefined ? { appId: appIdField } : {}),
    ...(appSecretField !== undefined ? { appSecret: appSecretField } : {}),
    ...(domainField !== undefined
      ? { domain: validateDomain("credentials.domain", domainField) }
      : {}),
  };

  const permissionMode = asPermissionModeOpt(
    "runtime.permissionMode",
    runtimeObj["permissionMode"],
  );

  const runtime: FileRuntime = {
    ...optStringField("runtime.cwd", runtimeObj["cwd"]),
    ...optNumberField(
      "runtime.idleTimeoutMinutes",
      asNonNegIntOpt("runtime.idleTimeoutMinutes", runtimeObj["idleTimeoutMinutes"]),
      "idleTimeoutMinutes",
    ),
    ...optNumberField(
      "runtime.maxChats",
      asPositiveIntOpt("runtime.maxChats", runtimeObj["maxChats"]),
      "maxChats",
    ),
    ...optBoolField("runtime.hideThoughts", runtimeObj["hideThoughts"]),
    ...optBoolField("runtime.hideTools", runtimeObj["hideTools"]),
    ...optBoolField("runtime.hideCancelButton", runtimeObj["hideCancelButton"]),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };

  const dataDir = asStringOpt("dataDir", root["dataDir"]);
  const agents = parseAgentsBlock(root["agents"]);

  return {
    credentials,
    ...(dataDir !== undefined ? { dataDir } : {}),
    runtime,
    agents,
  };
}

function parseAgentsBlock(value: unknown): Readonly<Record<string, UserPresetPatch>> {
  const obj = asObjectOpt("agents", value);
  if (!obj) return {};
  const out: Record<string, UserPresetPatch> = {};
  for (const [id, raw] of Object.entries(obj)) {
    const entry = asObjectOpt(`agents.${id}`, raw);
    if (!entry) continue;
    out[id] = parseAgentPatch(id, entry);
  }
  return out;
}

function parseAgentPatch(id: string, entry: Record<string, unknown>): UserPresetPatch {
  const label = asStringOpt(`agents.${id}.label`, entry["label"]);
  const command = asStringOpt(`agents.${id}.command`, entry["command"]);
  const description = asStringOpt(`agents.${id}.description`, entry["description"]);
  const args = parseAgentArgs(id, entry["args"]);
  const env = parseAgentEnv(id, entry["env"]);

  return {
    ...(label !== undefined ? { label } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(env !== undefined ? { env } : {}),
  };
}

function parseAgentArgs(id: string, value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CliError(`config: agents.${id}.args must be an array of strings`);
  }
  return value.map((token, idx) => {
    if (typeof token !== "string") {
      throw new CliError(`config: agents.${id}.args[${idx}] must be a string`);
    }
    return token;
  });
}

function parseAgentEnv(id: string, value: unknown): Readonly<Record<string, string>> | undefined {
  const obj = asObjectOpt(`agents.${id}.env`, value);
  if (!obj) return undefined;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val !== "string") {
      throw new CliError(`config: agents.${id}.env.${key} must be a string`);
    }
    out[key] = val;
  }
  return out;
}

function optStringField(label: string, value: unknown): Record<string, string> {
  const v = asStringOpt(label, value);
  if (v === undefined) return {};
  const key = label.split(".").pop() ?? label;
  return { [key]: v };
}

function optBoolField(label: string, value: unknown): Record<string, boolean> {
  const v = asBoolOpt(label, value);
  if (v === undefined) return {};
  const key = label.split(".").pop() ?? label;
  return { [key]: v };
}

function optNumberField(
  _label: string,
  value: number | undefined,
  key: string,
): Record<string, number> {
  if (value === undefined) return {};
  return { [key]: value };
}

// ---------- argv parsing --------------------------------------------------

type ParsedArgs = {
  readonly command: "proxy" | "agents" | "help" | "version";
  /** Preset id (`--agent <id>`); resolved against the registry in {@link runProxy}. */
  readonly agentPreset?: string;
  /** Raw command from `proxy -- <cmd>`; mutually exclusive with `agentPreset`. */
  readonly agentRawCommand?: string;
  /** Extra args: appended to the preset, or following the raw command. */
  readonly agentExtraArgs: readonly string[];
  readonly cwd?: string;
  readonly configPath?: string;
  readonly dataDir?: string;
  readonly domain?: string;
  readonly idleTimeoutMinutes?: number;
  readonly maxChats?: number;
  readonly hideThoughts?: boolean;
  readonly hideTools?: boolean;
  readonly hideCancelButton?: boolean;
  readonly permissionMode?: PermissionMode;
};

const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-v", "--version"]);

/**
 * Parse `process.argv.slice(2)` into a {@link ParsedArgs}.
 *
 * Global options come before the subcommand. Anything after `--` (which
 * must follow the `proxy` subcommand) is forwarded verbatim to the agent
 * process, so the agent's own flags are never consumed by this parser.
 *
 * @throws {CliError} when the input is structurally invalid.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  let i = 0;
  let cwd: string | undefined;
  let configPath: string | undefined;
  let dataDir: string | undefined;
  let domain: string | undefined;
  let idleTimeoutMinutes: number | undefined;
  let maxChats: number | undefined;
  let hideThoughts: boolean | undefined;
  let hideTools: boolean | undefined;
  let hideCancelButton: boolean | undefined;
  let permissionMode: PermissionMode | undefined;
  let agentPreset: string | undefined;

  const takeValue = (flag: string): string => {
    const value = argv[++i];
    if (value === undefined || value.startsWith("-")) {
      throw new CliError(`option ${flag} requires a value`);
    }
    return value;
  };

  const parseInt = (flag: string, raw: string, allowZero: boolean): number => {
    const n = Number(raw);
    const lower = allowZero ? 0 : 1;
    if (!Number.isInteger(n) || n < lower) {
      throw new CliError(
        `${flag} must be ${allowZero ? "a non-negative" : "a positive"} integer (got: ${raw})`,
      );
    }
    return n;
  };

  // ----- 1. global options + subcommand discovery -----
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) break;

    if (HELP_FLAGS.has(token)) return finalize("help");
    if (VERSION_FLAGS.has(token)) return finalize("version");

    if (token === "proxy") {
      i++;
      break;
    }
    if (token === "agents") return finalize("agents");
    if (token === "help") return finalize("help");
    if (token === "version") return finalize("version");

    switch (token) {
      case "--cwd":
        cwd = takeValue("--cwd");
        break;
      case "--config":
        configPath = takeValue("--config");
        break;
      case "--data-dir":
        dataDir = takeValue("--data-dir");
        break;
      case "--domain":
        domain = validateDomain("--domain", takeValue("--domain"));
        break;
      case "--idle-timeout":
        idleTimeoutMinutes = parseInt("--idle-timeout", takeValue("--idle-timeout"), true);
        break;
      case "--max-chats":
        maxChats = parseInt("--max-chats", takeValue("--max-chats"), false);
        break;
      case "--hide-thoughts":
        hideThoughts = true;
        break;
      case "--hide-tools":
        hideTools = true;
        break;
      case "--hide-cancel-button":
        hideCancelButton = true;
        break;
      case "--permission-mode": {
        const raw = takeValue("--permission-mode");
        if (!isPermissionMode(raw)) {
          throw new CliError(
            `--permission-mode must be one of: ${PERMISSION_MODES.join(" | ")} (got: ${raw})`,
          );
        }
        permissionMode = raw;
        break;
      }
      default:
        if (token.startsWith("-")) throw new CliError(`unknown option: ${token}`);
        throw new CliError(`unexpected positional argument before subcommand: ${token}`);
    }
    i++;
  }

  if (i === argv.length && !argv.includes("proxy")) return finalize("help");

  // ----- 2. proxy-local options (everything until `--` or end) -----
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) break;
    if (token === "--") break;
    if (!token.startsWith("-")) break; // first positional starts the agent command
    if (token === "--agent") {
      agentPreset = takeValue("--agent");
      i++;
      continue;
    }
    // `--domain` pairs naturally with `--agent`, so accept it here too
    // (it also works as a global option before `proxy`).
    if (token === "--domain") {
      domain = validateDomain("--domain", takeValue("--domain"));
      i++;
      continue;
    }
    throw new CliError(
      `unknown option after \`proxy\`: ${token}` +
        " (only --agent and --domain may follow `proxy`; other global options must" +
        " appear before `proxy`, and agent flags must appear after `--`)",
    );
  }

  // ----- 3. agent command -----
  const sawDashDash = argv[i] === "--";
  if (sawDashDash) i++;
  const trailing = argv.slice(i);

  let agentRawCommand: string | undefined;
  let agentExtraArgs: readonly string[];

  if (agentPreset !== undefined) {
    if (!sawDashDash && trailing.length > 0) {
      throw new CliError(
        "cannot combine --agent with a positional command; pass extra flags after `--`",
      );
    }
    agentExtraArgs = trailing;
  } else {
    agentRawCommand = trailing[0];
    if (!agentRawCommand) {
      throw new CliError(
        "proxy requires either --agent <preset> or a command after `--`. " +
          "Example: lark-acp proxy --agent claude",
      );
    }
    agentExtraArgs = trailing.slice(1);
  }

  return finalize("proxy", agentRawCommand, agentExtraArgs);

  function finalize(
    command: ParsedArgs["command"],
    agentRawCmd?: string,
    agentExtraList: readonly string[] = [],
  ): ParsedArgs {
    return {
      command,
      ...(agentPreset !== undefined ? { agentPreset } : {}),
      ...(agentRawCmd !== undefined ? { agentRawCommand: agentRawCmd } : {}),
      agentExtraArgs: agentExtraList,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(configPath !== undefined ? { configPath } : {}),
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(domain !== undefined ? { domain } : {}),
      ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
      ...(maxChats !== undefined ? { maxChats } : {}),
      ...(hideThoughts !== undefined ? { hideThoughts } : {}),
      ...(hideTools !== undefined ? { hideTools } : {}),
      ...(hideCancelButton !== undefined ? { hideCancelButton } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
    };
  }
}

// ---------- effective config ---------------------------------------------

type EffectiveConfig = {
  readonly appId: string;
  readonly appSecret: string;
  readonly credentialsSource: string;
  readonly domain: LarkDomainName | string;
  readonly domainSource: string;
  readonly cwd: string;
  readonly dataDir: string;
  readonly idleTimeoutMs: number;
  readonly maxChats: number;
  readonly showThoughts: boolean;
  readonly showTools: boolean;
  readonly showCancelButton: boolean;
  readonly permissionMode: PermissionMode;
};

/**
 * Merge file config, env vars, and CLI flags into a single resolved
 * config. Order of precedence is documented at the top of this file.
 *
 * @throws {CliError} when required fields (credentials, valid cwd) are
 *         missing or invalid.
 */
function resolveConfig(args: ParsedArgs, configPath: string, file: FileConfig): EffectiveConfig {
  // ----- credentials: env > file -----
  const envId = process.env[ENV_APP_ID];
  const envSecret = process.env[ENV_APP_SECRET];
  const appId = envId ?? file.credentials.appId;
  const appSecret = envSecret ?? file.credentials.appSecret;
  if (!appId || !appSecret) {
    const lines = [
      "Lark credentials missing.",
      "",
      "Provide them via either:",
      `  • environment variables ${ENV_APP_ID} and ${ENV_APP_SECRET}`,
      `  • a JSON config file at ${configPath} of the form:`,
      `      { "credentials": { "appId": "cli_...", "appSecret": "..." } }`,
    ];
    throw new CliError(lines.join("\n"));
  }
  const idSource = envId ? `env:${ENV_APP_ID}` : `file:${configPath}`;
  const secretSource = envSecret ? `env:${ENV_APP_SECRET}` : `file:${configPath}`;
  const credentialsSource = idSource === secretSource ? idSource : `${idSource}+${secretSource}`;

  // ----- domain: flag > env > file > default -----
  const envDomain = process.env[ENV_DOMAIN];
  const validatedEnvDomain =
    envDomain !== undefined && envDomain.length > 0
      ? validateDomain(ENV_DOMAIN, envDomain)
      : undefined;
  const domain =
    args.domain ?? validatedEnvDomain ?? file.credentials.domain ?? DEFAULT_LARK_DOMAIN;
  const domainSource =
    args.domain !== undefined
      ? "flag:--domain"
      : validatedEnvDomain !== undefined
        ? `env:${ENV_DOMAIN}`
        : file.credentials.domain !== undefined
          ? `file:${configPath}`
          : "default";

  // ----- cwd: flag > file > process.cwd() -----
  const rawCwd = args.cwd ?? file.runtime.cwd ?? process.cwd();
  const cwd = path.resolve(rawCwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new CliError(`cwd "${cwd}" is not a directory`);
  }

  // ----- dataDir: flag > env > file > XDG default -----
  const rawDataDir = args.dataDir ?? envDataDirOverride() ?? file.dataDir ?? defaultDataDir();
  const dataDir = path.resolve(rawDataDir);

  // ----- runtime knobs: flag > file > built-in default -----
  const idleTimeoutMinutes =
    args.idleTimeoutMinutes ?? file.runtime.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES;
  const maxChats = args.maxChats ?? file.runtime.maxChats ?? DEFAULT_MAX_CHATS;

  // The CLI flags are inverted from the LarkBridge option names — keep
  // the user-facing "hide-X" semantics here and flip once when handing
  // off to the bridge.
  const hideThoughts = args.hideThoughts ?? file.runtime.hideThoughts ?? false;
  const hideTools = args.hideTools ?? file.runtime.hideTools ?? false;
  const hideCancelButton = args.hideCancelButton ?? file.runtime.hideCancelButton ?? false;

  const envPermissionMode = process.env[ENV_PERMISSION_MODE];
  if (envPermissionMode !== undefined && !isPermissionMode(envPermissionMode)) {
    throw new CliError(
      `${ENV_PERMISSION_MODE} must be one of: ${PERMISSION_MODES.join(" | ")} (got: ${envPermissionMode})`,
    );
  }
  const permissionMode =
    args.permissionMode ??
    (envPermissionMode as PermissionMode | undefined) ??
    file.runtime.permissionMode ??
    DEFAULT_PERMISSION_MODE;

  return {
    appId,
    appSecret,
    credentialsSource,
    domain,
    domainSource,
    cwd,
    dataDir,
    idleTimeoutMs: idleTimeoutMinutes * 60_000,
    maxChats,
    showThoughts: !hideThoughts,
    showTools: !hideTools,
    showCancelButton: !hideCancelButton,
    permissionMode,
  };
}

// ---------- output helpers -----------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function printVersion(): void {
  process.stdout.write(`${APP_NAME} v${VERSION}\n`);
}

function printHelp(): void {
  const presetIds = Array.from(buildRegistry().keys()).join(" | ");
  const lines = [
    `${APP_NAME} v${VERSION} — bridge Lark to any ACP-compatible AI agent`,
    ``,
    `Usage:`,
    `  ${APP_NAME} [global-options] proxy --agent <preset> [-- <extra-args>...]`,
    `  ${APP_NAME} [global-options] proxy -- <agent-cmd> [agent-args]...`,
    `  ${APP_NAME} agents`,
    `  ${APP_NAME} help`,
    `  ${APP_NAME} version`,
    ``,
    `Global options (must appear BEFORE the proxy subcommand):`,
    `  --cwd <dir>            Working directory for the agent subprocess`,
    `  --config <path>        Override the config file path`,
    `                         (default: $XDG_CONFIG_HOME/${APP_NAME}/${CONFIG_FILE},`,
    `                          fallback ~/.config/${APP_NAME}/${CONFIG_FILE})`,
    `  --data-dir <dir>       Override the on-disk state directory`,
    `                         (default: $XDG_DATA_HOME/${APP_NAME},`,
    `                          fallback ~/.local/share/${APP_NAME})`,
    `  --domain <region>      Lark/Feishu deployment: ${LARK_DOMAINS.join(" | ")}`,
    `                         or a custom base URL (default ${DEFAULT_LARK_DOMAIN}).`,
    `                         Use "lark" for apps on Lark International`,
    `                         (open.larksuite.com); the default targets Feishu`,
    `                         (open.feishu.cn). May also be placed after \`proxy\`.`,
    `  --idle-timeout <min>   Evict idle chats after N minutes (0 = never; default ${DEFAULT_IDLE_TIMEOUT_MINUTES})`,
    `  --max-chats <n>        Maximum concurrent chats (default ${DEFAULT_MAX_CHATS})`,
    `  --hide-thoughts        Skip agent_thought_chunk events in the unified card`,
    `  --hide-tools           Skip tool_call events in the unified card`,
    `  --hide-cancel-button   Don't render the in-card "interrupt" button`,
    `  --permission-mode <m>  How to handle agent permission requests:`,
    `                         ${PERMISSION_MODES.join(" | ")} (default ${DEFAULT_PERMISSION_MODE})`,
    `  -h, --help             Show this help and exit`,
    `  -v, --version          Show version and exit`,
    ``,
    `Subcommands:`,
    `  proxy                  Spawn an ACP agent subprocess and bridge it to Lark.`,
    `    --agent <preset>     Use a built-in preset: ${presetIds}`,
    `    --domain <region>    Same as the global --domain, accepted here for convenience.`,
    `    -- <cmd> [args...]   Or pass a raw command. Tokens after \`--\` are forwarded`,
    `                         verbatim, so the agent's own flags are never re-parsed.`,
    `                         Combined with --agent, extra tokens are appended to the`,
    `                         preset's args.`,
    `  agents                 List built-in agent presets and exit.`,
    ``,
    `Configuration file (${CONFIG_FILE}):`,
    `  {`,
    `    "credentials": { "appId": "cli_...", "appSecret": "...", "domain": "${DEFAULT_LARK_DOMAIN}" },`,
    `    "dataDir": "./var/lark-acp",`,
    `    "runtime": {`,
    `      "cwd": "/work/project",`,
    `      "idleTimeoutMinutes": ${DEFAULT_IDLE_TIMEOUT_MINUTES},`,
    `      "maxChats": ${DEFAULT_MAX_CHATS},`,
    `      "hideThoughts": false,`,
    `      "hideTools": false,`,
    `      "hideCancelButton": false,`,
    `      "permissionMode": "${DEFAULT_PERMISSION_MODE}"`,
    `    },`,
    `    "agents": {`,
    `      "my-claude": {`,
    `        "label": "Claude (custom)",`,
    `        "command": "npx",`,
    `        "args": ["-y", "@zed-industries/claude-code-acp"],`,
    `        "env": { "ANTHROPIC_API_KEY": "..." }`,
    `      },`,
    `      "claude": { "env": { "ANTHROPIC_BASE_URL": "https://..." } }`,
    `    }`,
    `  }`,
    ``,
    `  All fields are optional. CLI flags override file values; env vars`,
    `  ${ENV_APP_ID} / ${ENV_APP_SECRET} override the credentials block;`,
    `  ${ENV_DOMAIN} overrides credentials.domain;`,
    `  ${ENV_PERMISSION_MODE} overrides runtime.permissionMode.`,
    `  Entries under "agents" with a built-in id patch that preset; new ids`,
    `  add user presets and must define both \`label\` and \`command\`.`,
    ``,
    `Examples:`,
    `  ${APP_NAME} proxy --agent claude`,
    `  ${APP_NAME} --domain lark proxy --agent claude`,
    `  ${APP_NAME} --cwd /work/project proxy --agent opencode`,
    `  ${APP_NAME} --hide-thoughts proxy --agent copilot`,
    `  ${APP_NAME} --permission-mode alwaysAllow proxy --agent claude`,
    `  ${APP_NAME} proxy -- node ./my-acp-server.js`,
    ``,
  ];
  process.stdout.write(lines.join("\n"));
}

const SOURCE_TAG: Record<"built-in" | "user" | "overridden", string> = {
  "built-in": "[built-in]",
  user: "[user]",
  overridden: "[overridden]",
};

function printAgents(registry: Registry): void {
  const lines = [`ACP agent presets:`, ``];
  const idColWidth = Math.max(...Array.from(registry.keys(), (id) => id.length));
  for (const [id, entry] of registry) {
    const { preset, source } = entry;
    const fullCmd = [preset.command, ...preset.args].join(" ");
    lines.push(`  ${id.padEnd(idColWidth)}  ${preset.label} ${SOURCE_TAG[source]}`);
    if (preset.description) lines.push(`  ${" ".repeat(idColWidth)}  ${preset.description}`);
    lines.push(`  ${" ".repeat(idColWidth)}  $ ${fullCmd}`);
    lines.push("");
  }
  lines.push(`Use any of these with \`${APP_NAME} proxy --agent <id>\`.`);
  lines.push(`Add or override entries via the \`agents\` field of ${CONFIG_FILE}.`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

// ---------- main ---------------------------------------------------------

type ResolvedAgentInvocation = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly displayLabel: string;
};

function resolveAgentInvocation(args: ParsedArgs, registry: Registry): ResolvedAgentInvocation {
  if (args.agentPreset !== undefined) {
    const entry = registry.get(args.agentPreset);
    if (!entry) {
      throw new CliError(
        `unknown agent preset: ${args.agentPreset} (run \`lark-acp agents\` to list presets)`,
      );
    }
    const combinedArgs = [...entry.preset.args, ...args.agentExtraArgs];
    const display = `${args.agentPreset} (${entry.preset.command} ${combinedArgs.join(" ")})`;
    return {
      command: entry.preset.command,
      args: combinedArgs,
      ...(entry.preset.env ? { env: { ...entry.preset.env } } : {}),
      displayLabel: display.trimEnd(),
    };
  }
  if (args.agentRawCommand === undefined) {
    throw new CliError("internal: runProxy called without an agent command");
  }
  const command = args.agentRawCommand;
  const cmdArgs = [...args.agentExtraArgs];
  return {
    command,
    args: cmdArgs,
    displayLabel: `${command} ${cmdArgs.join(" ")}`.trimEnd(),
  };
}

async function runProxy(args: ParsedArgs): Promise<void> {
  const configPath = resolveConfigPath(args.configPath);
  const file = readConfigFile(configPath);
  const registry = buildRegistry(file.agents);
  const invocation = resolveAgentInvocation(args, registry);

  const cfg = resolveConfig(args, configPath, file);
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  const rootLogger = createPinoLogger();
  const cliLogger: LarkLogger = rootLogger.child({ name: "cli" });

  cliLogger.info(
    `config:      ${configPath}${fs.existsSync(configPath) ? "" : " (not found, using defaults)"}`,
  );
  cliLogger.info(`credentials: ${cfg.credentialsSource}`);
  cliLogger.info(`domain:      ${cfg.domain} (${cfg.domainSource})`);
  cliLogger.info(`agent:       ${invocation.displayLabel}`);
  cliLogger.info(`cwd:         ${cfg.cwd}`);
  cliLogger.info(`data:        ${cfg.dataDir}`);
  cliLogger.info(`permission:  ${cfg.permissionMode}`);

  const sessionStore = new FileSessionStore(cfg.dataDir);

  const bridge = new LarkBridge({
    lark: { appId: cfg.appId, appSecret: cfg.appSecret, domain: cfg.domain },
    agent: {
      command: invocation.command,
      args: [...invocation.args],
      ...(invocation.env ? { env: { ...invocation.env } } : {}),
      cwd: cfg.cwd,
      showThoughts: cfg.showThoughts,
      showTools: cfg.showTools,
      showCancelButton: cfg.showCancelButton,
      permissionMode: cfg.permissionMode,
    },
    session: {
      idleTimeoutMs: cfg.idleTimeoutMs,
      maxConcurrentChats: cfg.maxChats,
    },
    sessionStore,
    logger: rootLogger,
  });

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    cliLogger.info(`received ${signal}, stopping`);
    try {
      await bridge.stop();
    } catch (err) {
      cliLogger.error({ err: formatError(err) }, "error during shutdown");
    }
    process.exit(0);
  };
  process.on("SIGINT", (sig) => void shutdown(sig));
  process.on("SIGTERM", (sig) => void shutdown(sig));

  await bridge.start();
  cliLogger.info("bridge running. Press Ctrl+C to stop.");
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.stderr.write(`run \`${APP_NAME} --help\` for usage.\n`);
      process.exit(2);
    }
    throw err;
  }

  switch (args.command) {
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
    case "agents": {
      const configPath = resolveConfigPath(args.configPath);
      const file = readConfigFile(configPath);
      printAgents(buildRegistry(file.agents));
      return;
    }
    case "proxy":
      await runProxy(args);
      return;
    default:
      assertNever(args.command);
  }
}

function assertNever(x: never): never {
  throw new Error(`unexpected command: ${String(x)}`);
}

main().catch((err) => {
  if (err instanceof CliError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`fatal: ${formatError(err)}\n`);
  process.exit(1);
});
