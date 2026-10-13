/**
 * White-box unit tests for the shim launcher (architecture plan §5.2): npx
 * invocation parsing, prepared-bin resolution, and the launch rewrite.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  parseNpxInvocation,
  preferPreparedShim,
  resolvePreparedBin,
  stripVersion,
} from "./shims.js";

describe("stripVersion", () => {
  it("strips a trailing version, preserving a leading scope", () => {
    expect(stripVersion("@zed-industries/claude-code-acp@1.2.3")).toBe(
      "@zed-industries/claude-code-acp",
    );
    expect(stripVersion("pkg@2.0.0")).toBe("pkg");
    expect(stripVersion("@scope/pkg")).toBe("@scope/pkg");
    expect(stripVersion("pkg")).toBe("pkg");
  });
});

describe("parseNpxInvocation", () => {
  it("parses an `npx -y <pkg>` launch", () => {
    expect(
      parseNpxInvocation({ command: "npx", args: ["-y", "@zed-industries/codex-acp"] }),
    ).toEqual({ spec: "@zed-industries/codex-acp", pkg: "@zed-industries/codex-acp", rest: [] });
  });

  it("keeps trailing args and honours --yes / versions", () => {
    expect(
      parseNpxInvocation({
        command: "npx",
        args: ["--yes", "@google/gemini-cli@1.0.0", "--experimental-acp"],
      }),
    ).toEqual({
      spec: "@google/gemini-cli@1.0.0",
      pkg: "@google/gemini-cli",
      rest: ["--experimental-acp"],
    });
  });

  it("tolerates a .cmd/.exe npx basename with a full path", () => {
    const cmd = path.join("C:", "Program Files", "nodejs", "npx.cmd");
    expect(parseNpxInvocation({ command: cmd, args: ["-y", "pkg"] })?.pkg).toBe("pkg");
  });

  it("returns null for non-npx or malformed invocations", () => {
    expect(parseNpxInvocation({ command: "kiro-cli", args: ["acp"] })).toBeNull();
    expect(parseNpxInvocation({ command: "npx", args: ["-y"] })).toBeNull();
    expect(parseNpxInvocation({ command: "npx", args: ["-y", "--flag"] })).toBeNull();
  });
});

describe("prepared-bin resolution", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-acp-shims-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a fake installed package with a bin file under `dir/node_modules`. */
  function installFake(pkg: string, bin: string | Record<string, string>): void {
    const pkgDir = path.join(dir, "node_modules", ...pkg.split("/"));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkg, bin }));
    const rel = typeof bin === "string" ? bin : Object.values(bin)[0];
    if (rel) {
      const binPath = path.join(pkgDir, rel);
      fs.mkdirSync(path.dirname(binPath), { recursive: true });
      fs.writeFileSync(binPath, "#!/usr/bin/env node\n");
    }
  }

  it("resolves a string bin", () => {
    installFake("@zed-industries/claude-code-acp", "dist/index.js");
    const resolved = resolvePreparedBin("@zed-industries/claude-code-acp", dir);
    expect(resolved).toBe(
      path.join(dir, "node_modules", "@zed-industries", "claude-code-acp", "dist", "index.js"),
    );
  });

  it("resolves an object bin by short name, else the first entry", () => {
    installFake("gizmo", { gizmo: "cli.js", other: "other.js" });
    expect(resolvePreparedBin("gizmo", dir)).toBe(
      path.join(dir, "node_modules", "gizmo", "cli.js"),
    );
  });

  it("returns null when not installed or bin missing", () => {
    expect(resolvePreparedBin("@zed-industries/claude-code-acp", dir)).toBeNull();
  });

  it("rewrites a prepared npx launch to a node launch", () => {
    installFake("@zed-industries/codex-acp", "bin.js");
    const { invocation, prepared } = preferPreparedShim(
      { command: "npx", args: ["-y", "@zed-industries/codex-acp"] },
      dir,
    );
    expect(prepared).toBe(true);
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      path.join(dir, "node_modules", "@zed-industries", "codex-acp", "bin.js"),
    ]);
  });

  it("preserves trailing args in the rewrite", () => {
    installFake("@github/copilot", "index.js");
    const { invocation, prepared } = preferPreparedShim(
      { command: "npx", args: ["-y", "@github/copilot", "--acp"] },
      dir,
    );
    expect(prepared).toBe(true);
    expect(invocation.args).toEqual([
      path.join(dir, "node_modules", "@github", "copilot", "index.js"),
      "--acp",
    ]);
  });

  it("leaves the invocation unchanged when the shim isn't prepared", () => {
    const inv = { command: "npx", args: ["-y", "@zed-industries/codex-acp"] };
    const { invocation, prepared } = preferPreparedShim(inv, dir);
    expect(prepared).toBe(false);
    expect(invocation).toEqual(inv);
  });

  it("leaves a native (non-npx) invocation unchanged", () => {
    const inv = { command: "kiro-cli", args: ["acp"] };
    const { invocation, prepared } = preferPreparedShim(inv, dir);
    expect(prepared).toBe(false);
    expect(invocation).toBe(inv);
  });
});
