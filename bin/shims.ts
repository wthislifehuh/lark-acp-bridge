/**
 * Cold-start optimisation for `npx`-based agent presets (architecture plan
 * §5.2 — the pin-&-bundle win, refined to avoid install bloat).
 *
 * Several built-in presets launch a translation shim via
 * `npx -y <pkg> [args…]`. On every spawn `npx` re-resolves the package
 * (and, unpinned, may silently pull a newer "latest"), adding cold-start
 * latency and a supply-chain risk.
 *
 * Rather than forcing every install to bundle five heavyweight agent
 * packages as dependencies, the bridge lets the operator **prepare** the
 * shims once into a `dataDir`-local directory (`lark-acp prepare`). Once
 * prepared, {@link preferPreparedShim} rewrites the `npx …` invocation to
 * launch the shim's entrypoint directly with the current Node — no `npx`
 * resolution, no network, and a version pinned by the prepared install.
 * When a shim isn't prepared, the original `npx` invocation is used
 * unchanged, so nothing regresses.
 *
 * The rewrite is purely a *launcher* change: the same shim binary runs, so
 * per-tool permission cards and every other behaviour are untouched.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** A subprocess launch: a command and its arguments. */
export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

/** An `npx -y <pkg>[@version] [rest…]` invocation, decomposed. */
export interface NpxInvocation {
  /** The full package spec including any `@version` — used for `npm install`. */
  readonly spec: string;
  /** The bare package name (version stripped) — used to resolve a prepared install. */
  readonly pkg: string;
  /** Arguments after the package spec (e.g. `--acp`). */
  readonly rest: readonly string[];
}

const YES_FLAGS = new Set(["-y", "--yes"]);

/** Directory name, under `dataDir`, holding prepared shim installs. */
export const SHIMS_DIRNAME = "shims";

/** True when `command`'s basename is `npx` (tolerating `.cmd` / `.exe`). */
function isNpxCommand(command: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === "npx" || base === "npx.cmd" || base === "npx.exe";
}

/**
 * Strip a trailing `@version` from a package spec, preserving a leading
 * scope. `@scope/pkg@1.2.3` → `@scope/pkg`; `pkg@1.2.3` → `pkg`.
 */
export function stripVersion(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at <= 0 ? spec : spec.slice(0, at);
}

/**
 * Parse an {@link Invocation} as an `npx` shim launch, or return `null`
 * when it isn't one (native binary, raw command, malformed).
 */
export function parseNpxInvocation(inv: Invocation): NpxInvocation | null {
  if (!isNpxCommand(inv.command)) return null;

  let i = 0;
  while (i < inv.args.length && YES_FLAGS.has(inv.args[i] ?? "")) i++;
  const spec = inv.args[i];
  if (spec === undefined || spec.startsWith("-")) return null;

  return { spec, pkg: stripVersion(spec), rest: inv.args.slice(i + 1) };
}

/** Pick the bin entrypoint (relative path) from a package.json `bin` field. */
function pickBin(bin: unknown, pkgName: string): string | null {
  if (typeof bin === "string") return bin;
  if (bin !== null && typeof bin === "object") {
    const map = bin as Record<string, unknown>;
    const short = pkgName.includes("/") ? (pkgName.split("/").pop() ?? pkgName) : pkgName;
    const preferred = map[short];
    if (typeof preferred === "string") return preferred;
    const first = Object.values(map).find((v) => typeof v === "string");
    return typeof first === "string" ? first : null;
  }
  return null;
}

/**
 * Resolve a prepared package's bin entrypoint under `preparedDir`, or
 * `null` when it isn't installed / has no usable bin.
 */
export function resolvePreparedBin(pkg: string, preparedDir: string): string | null {
  const pkgDir = path.join(preparedDir, "node_modules", ...pkg.split("/"));
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return null;

  let parsed: { bin?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { bin?: unknown };
  } catch {
    return null;
  }

  const rel = pickBin(parsed.bin, pkg);
  if (rel === null) return null;
  const binAbs = path.join(pkgDir, rel);
  return fs.existsSync(binAbs) ? binAbs : null;
}

/**
 * If `inv` is an `npx` shim launch whose package is prepared under
 * `preparedDir`, rewrite it to run the shim's entrypoint directly with the
 * current Node executable. Otherwise return `inv` unchanged.
 */
export function preferPreparedShim(
  inv: Invocation,
  preparedDir: string,
): { readonly invocation: Invocation; readonly prepared: boolean } {
  const npx = parseNpxInvocation(inv);
  if (!npx) return { invocation: inv, prepared: false };

  const bin = resolvePreparedBin(npx.pkg, preparedDir);
  if (bin === null) return { invocation: inv, prepared: false };

  return {
    invocation: { command: process.execPath, args: [bin, ...npx.rest] },
    prepared: true,
  };
}
