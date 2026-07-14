/**
 * Shared Entra ID (MSAL) token acquisition for the bundled Microsoft adapters
 * (`lark-acp-copilot-studio`, `lark-acp-m365`).
 *
 * Flow: a one-time interactive `login` subcommand runs the device-code flow
 * and persists the MSAL token cache to disk; at bridge runtime the adapters
 * only ever call {@link acquireTokenSilently}, which refreshes via the cached
 * refresh token and never prompts. When silent acquisition is impossible the
 * error message starts with "Authentication required" — the bridge
 * pattern-matches that prefix (see `isAuthenticationError` in
 * `src/bridge/chat-runtime.ts`) and tears the runtime down instead of
 * retrying.
 */

import fs from "node:fs";
import path from "node:path";
import {
  ConfidentialClientApplication,
  PublicClientApplication,
  type Configuration,
  type ICachePlugin,
  type TokenCacheContext,
} from "@azure/msal-node";

export const DEFAULT_AUTHORITY_BASE = "https://login.microsoftonline.com";

/** Owner read/write only — the cache holds refresh tokens. */
const CACHE_FILE_MODE = 0o600;

export interface MsalAuthOptions {
  readonly clientId: string;
  readonly tenantId: string;
  /** Authority host, e.g. `https://login.microsoftonline.com`. */
  readonly authorityBase?: string;
  readonly scopes: readonly string[];
  /** Serialized MSAL token cache location (created on demand). */
  readonly cacheFilePath: string;
}

/**
 * Silent token acquisition failed and an interactive re-login is needed.
 * The "Authentication required" message prefix is load-bearing: the bridge
 * detects it and shows a login hint instead of retrying the prompt.
 */
export class AuthRequiredError extends Error {
  constructor(loginCommand: string, options?: { cause?: unknown }) {
    super(
      `Authentication required: 请先在终端运行 \`${loginCommand}\` 完成 Microsoft 登录后重试`,
      options,
    );
    this.name = "AuthRequiredError";
  }
}

/**
 * File-backed MSAL cache. MSAL invokes the hooks around every cache access,
 * so device-code logins and silent refreshes stay in sync across processes.
 */
function createDiskCachePlugin(cacheFilePath: string): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      try {
        const data = await fs.promises.readFile(cacheFilePath, "utf8");
        context.tokenCache.deserialize(data);
      } catch (err: unknown) {
        // Missing cache = first run; anything else is surfaced on write.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      if (!context.cacheHasChanged) return;
      await fs.promises.mkdir(path.dirname(cacheFilePath), { recursive: true });
      await fs.promises.writeFile(cacheFilePath, context.tokenCache.serialize(), {
        encoding: "utf8",
        mode: CACHE_FILE_MODE,
      });
    },
  };
}

function buildPublicClient(options: MsalAuthOptions): PublicClientApplication {
  const authorityBase = options.authorityBase ?? DEFAULT_AUTHORITY_BASE;
  const config: Configuration = {
    auth: {
      clientId: options.clientId,
      authority: `${authorityBase}/${options.tenantId}`,
    },
    cache: { cachePlugin: createDiskCachePlugin(options.cacheFilePath) },
  };
  return new PublicClientApplication(config);
}

/**
 * Interactive device-code login. Meant for the adapters' `login` subcommand
 * running in a real terminal; `onInstruction` receives the human-readable
 * "open https://microsoft.com/devicelogin and enter CODE" message.
 *
 * @throws when the device-code flow fails or is not enabled for the app
 *         registration ("public client flows" toggle in Entra).
 */
export async function loginWithDeviceCode(
  options: MsalAuthOptions,
  onInstruction: (message: string) => void,
): Promise<string> {
  const pca = buildPublicClient(options);
  const result = await pca.acquireTokenByDeviceCode({
    scopes: [...options.scopes],
    deviceCodeCallback: (info) => {
      onInstruction(info.message);
    },
  });
  if (!result?.account) {
    throw new Error("Device-code login did not return an account");
  }
  return result.account.username;
}

/**
 * Acquire an access token without user interaction, using the on-disk cache
 * populated by {@link loginWithDeviceCode}.
 *
 * @throws {AuthRequiredError} when no cached account exists or the silent
 *         refresh is rejected (revoked / expired refresh token, Conditional
 *         Access change, ...).
 */
export async function acquireTokenSilently(
  options: MsalAuthOptions,
  loginCommand: string,
): Promise<string> {
  const pca = buildPublicClient(options);
  const accounts = await pca.getTokenCache().getAllAccounts();
  const account = accounts[0];
  if (!account) throw new AuthRequiredError(loginCommand);
  try {
    const result = await pca.acquireTokenSilent({ account, scopes: [...options.scopes] });
    return result.accessToken;
  } catch (err: unknown) {
    throw new AuthRequiredError(loginCommand, { cause: err });
  }
}

/**
 * App-only (client credentials) token source — no user, no cache file. The
 * returned function reuses one MSAL instance so tokens are served from its
 * in-memory cache until close to expiry.
 *
 * The returned function throws when Entra rejects the client credentials
 * (bad secret, missing application permission / admin consent, service not
 * enabled).
 */
export function createClientSecretTokenSource(
  options: Omit<MsalAuthOptions, "cacheFilePath">,
  clientSecret: string,
): () => Promise<string> {
  const authorityBase = options.authorityBase ?? DEFAULT_AUTHORITY_BASE;
  const cca = new ConfidentialClientApplication({
    auth: {
      clientId: options.clientId,
      authority: `${authorityBase}/${options.tenantId}`,
      clientSecret,
    },
  });
  return async () => {
    const result = await cca.acquireTokenByClientCredential({ scopes: [...options.scopes] });
    if (!result) throw new Error("Client-credential token acquisition returned no result");
    return result.accessToken;
  };
}
