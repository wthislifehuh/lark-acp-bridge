/**
 * White-box unit tests for the OS service definition generator
 * (architecture plan item #4). Platform is a spec field, so all three
 * targets are exercised regardless of the host OS.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildServiceDefinition, type ServiceSpec } from "./service.js";

const BASE = {
  nodePath: "/usr/bin/node",
  scriptPath: "/opt/lark/dist/bin/lark-acp.js",
  args: ["--config", "/home/me/cfg.json", "proxy", "--agent", "claude"],
  workingDir: "/work/project",
  homeDir: "/home/me",
  dataDir: "/home/me/.local/share/lark-acp",
} satisfies Omit<ServiceSpec, "platform">;

describe("buildServiceDefinition — systemd", () => {
  const def = buildServiceDefinition({ ...BASE, platform: "linux" });

  it("writes to the user systemd unit path", () => {
    expect(def.filePath).toBe(
      path.join("/home/me", ".config", "systemd", "user", "lark-acp.service"),
    );
  });

  it("embeds a full ExecStart with node, script and args, and restarts on failure", () => {
    expect(def.content).toContain(
      "ExecStart=/usr/bin/node /opt/lark/dist/bin/lark-acp.js --config /home/me/cfg.json proxy --agent claude",
    );
    expect(def.content).toContain("Restart=on-failure");
    expect(def.content).toContain("WantedBy=default.target");
  });

  it("quotes args containing spaces", () => {
    const spaced = buildServiceDefinition({
      ...BASE,
      platform: "linux",
      args: ["--cwd", "/work/my project", "proxy", "--agent", "claude"],
    });
    expect(spaced.content).toContain('"/work/my project"');
  });

  it("prints activation and status commands", () => {
    expect(def.activate.join("\n")).toContain("systemctl --user enable --now lark-acp.service");
    expect(def.status).toBe("systemctl --user status lark-acp.service");
  });
});

describe("buildServiceDefinition — launchd", () => {
  const def = buildServiceDefinition({ ...BASE, platform: "darwin" });

  it("writes a LaunchAgent plist to the home Library path", () => {
    expect(def.filePath).toBe(
      path.join("/home/me", "Library", "LaunchAgents", "com.lark-acp.bridge.plist"),
    );
  });

  it("lists each program argument as a <string> and keeps the process alive", () => {
    expect(def.content).toContain("<string>/usr/bin/node</string>");
    expect(def.content).toContain("<string>/opt/lark/dist/bin/lark-acp.js</string>");
    expect(def.content).toContain("<string>claude</string>");
    expect(def.content).toContain("<key>KeepAlive</key>");
    expect(def.content).toContain("<true/>");
  });

  it("uses launchctl load/unload for activation", () => {
    expect(def.activate[0]).toContain("launchctl load -w");
    expect(def.deactivate[0]).toContain("launchctl unload -w");
  });
});

describe("buildServiceDefinition — Task Scheduler", () => {
  const def = buildServiceDefinition({ ...BASE, platform: "win32" });

  it("writes the task XML under the data dir", () => {
    expect(def.filePath).toBe(
      path.join("/home/me/.local/share/lark-acp", "service", "lark-acp-bridge.xml"),
    );
  });

  it("embeds the command and arguments with a logon trigger and restart", () => {
    expect(def.content).toContain("<Command>/usr/bin/node</Command>");
    expect(def.content).toContain("/opt/lark/dist/bin/lark-acp.js");
    expect(def.content).toContain("<LogonTrigger>");
    expect(def.content).toContain("<RestartOnFailure>");
  });

  it("registers and runs via schtasks", () => {
    expect(def.activate.join("\n")).toContain("schtasks /Create /TN lark-acp-bridge");
    expect(def.deactivate.join("\n")).toContain("schtasks /Delete /TN lark-acp-bridge");
  });

  it("XML-escapes arguments containing quotes/ampersands", () => {
    const tricky = buildServiceDefinition({
      ...BASE,
      platform: "win32",
      args: ["--config", "C:\\a & b\\cfg.json", "proxy", "--agent", "claude"],
    });
    expect(tricky.content).toContain("&amp;");
    expect(tricky.content).not.toContain("a & b\\cfg.json</Arguments>");
  });
});
