/**
 * Env-var parsing helpers shared by the bundled adapters' configuration
 * loaders.
 */

export function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function positiveIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = envValue(env, key);
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Unset → `defaultValue`; "false"/"0" (case-insensitive) → false; else true. */
export function booleanEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: boolean): boolean {
  const raw = envValue(env, key);
  if (raw === null) return defaultValue;
  return !["false", "0"].includes(raw.toLowerCase());
}
