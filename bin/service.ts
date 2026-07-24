/**
 * OS service definition generation for running the bridge unattended
 * (architecture plan Phase-1 item #4): a systemd **user** unit on Linux, a
 * launchd **LaunchAgent** on macOS, and a Task Scheduler task on Windows.
 *
 * Generation is pure and testable; the CLI (`lark-acp service …`) writes the
 * file to the platform-conventional location and prints the exact commands
 * to activate / deactivate / query it. Activation is left to the operator
 * (one command) rather than auto-run: it keeps the tool from mutating the
 * service manager or leaving a half-configured state, and user-level units
 * need no root.
 */

import path from "node:path";

export type ServicePlatform = "linux" | "darwin" | "win32";

export interface ServiceSpec {
  readonly platform: ServicePlatform;
  /** Absolute path to the Node executable (`process.execPath`). */
  readonly nodePath: string;
  /** Absolute path to the compiled `lark-acp` entrypoint. */
  readonly scriptPath: string;
  /** Argument vector passed to the script (global flags + `proxy --agent …`). */
  readonly args: readonly string[];
  /** Working directory for the service process. */
  readonly workingDir: string;
  readonly homeDir: string;
  /** Bridge data dir — used to place the Windows task XML and log files. */
  readonly dataDir: string;
}

export interface ServiceDefinition {
  /** Service / task identifier. */
  readonly label: string;
  /** Where the definition file is written. */
  readonly filePath: string;
  /** File contents (unit / plist / task XML). */
  readonly content: string;
  /** Commands the operator runs to enable + start the service. */
  readonly activate: readonly string[];
  /** Commands to stop + remove the service. */
  readonly deactivate: readonly string[];
  /** Command to query service status. */
  readonly status: string;
}

const LINUX_LABEL = "lark-acp";
const DARWIN_LABEL = "com.lark-acp.bridge";
const WINDOWS_LABEL = "lark-acp-bridge";

/** Build the platform-appropriate service definition. */
export function buildServiceDefinition(spec: ServiceSpec): ServiceDefinition {
  switch (spec.platform) {
    case "linux":
      return buildSystemd(spec);
    case "darwin":
      return buildLaunchd(spec);
    case "win32":
      return buildTaskScheduler(spec);
  }
}

/** Quote a token for a systemd `ExecStart=` line (double-quote when it has spaces). */
function systemdQuote(token: string): string {
  return /\s/.test(token) ? `"${token.replaceAll('"', '\\"')}"` : token;
}

function buildSystemd(spec: ServiceSpec): ServiceDefinition {
  const exec = [spec.nodePath, spec.scriptPath, ...spec.args].map(systemdQuote).join(" ");
  const filePath = path.join(spec.homeDir, ".config", "systemd", "user", `${LINUX_LABEL}.service`);
  const content = [
    "[Unit]",
    "Description=lark-acp-bridge (Feishu/Lark ACP bridge)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    `WorkingDirectory=${spec.workingDir}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return {
    label: LINUX_LABEL,
    filePath,
    content,
    activate: [
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${LINUX_LABEL}.service`,
      "# optional: start at boot without an active login session:",
      "loginctl enable-linger $USER",
    ],
    deactivate: [`systemctl --user disable --now ${LINUX_LABEL}.service`],
    status: `systemctl --user status ${LINUX_LABEL}.service`,
  };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildLaunchd(spec: ServiceSpec): ServiceDefinition {
  const filePath = path.join(spec.homeDir, "Library", "LaunchAgents", `${DARWIN_LABEL}.plist`);
  const logDir = path.join(spec.dataDir, "logs");
  const programArgs = [spec.nodePath, spec.scriptPath, ...spec.args]
    .map((a) => `      <string>${xmlEscape(a)}</string>`)
    .join("\n");
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${DARWIN_LABEL}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    programArgs,
    "    </array>",
    "    <key>WorkingDirectory</key>",
    `    <string>${xmlEscape(spec.workingDir)}</string>`,
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>StandardOutPath</key>",
    `    <string>${xmlEscape(path.join(logDir, "lark-acp.out.log"))}</string>`,
    "    <key>StandardErrorPath</key>",
    `    <string>${xmlEscape(path.join(logDir, "lark-acp.err.log"))}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
  return {
    label: DARWIN_LABEL,
    filePath,
    content,
    activate: [`launchctl load -w ${filePath}`],
    deactivate: [`launchctl unload -w ${filePath}`],
    status: `launchctl list | grep ${DARWIN_LABEL}`,
  };
}

function buildTaskScheduler(spec: ServiceSpec): ServiceDefinition {
  const filePath = path.join(spec.dataDir, "service", `${WINDOWS_LABEL}.xml`);
  const argsAttr = xmlEscape(
    [spec.scriptPath, ...spec.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "),
  );
  // A minimal Task Scheduler definition: run at logon, restart on failure.
  const content = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>lark-acp-bridge (Feishu/Lark ACP bridge)</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "  </Settings>",
    "  <Actions>",
    "    <Exec>",
    `      <Command>${xmlEscape(spec.nodePath)}</Command>`,
    `      <Arguments>${argsAttr}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(spec.workingDir)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");
  return {
    label: WINDOWS_LABEL,
    filePath,
    content,
    activate: [
      `schtasks /Create /TN ${WINDOWS_LABEL} /XML "${filePath}" /F`,
      `schtasks /Run /TN ${WINDOWS_LABEL}`,
    ],
    deactivate: [`schtasks /End /TN ${WINDOWS_LABEL}`, `schtasks /Delete /TN ${WINDOWS_LABEL} /F`],
    status: `schtasks /Query /TN ${WINDOWS_LABEL} /V /FO LIST`,
  };
}
