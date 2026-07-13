import * as Lark from "@larksuiteoapi/node-sdk";

/**
 * Which Lark/Feishu deployment the bot's app is registered on.
 *
 * The underlying SDK defaults to Feishu (`open.feishu.cn`, China). Apps
 * created on **Lark International** (`open.larksuite.com`) must select
 * `"lark"`, otherwise the server rejects the WebSocket / HTTP handshake
 * with code `1000040351` ("Incorrect domain name").
 */
export const LARK_DOMAINS = ["feishu", "lark"] as const;

export type LarkDomainName = (typeof LARK_DOMAINS)[number];

/**
 * What callers may pass as a `domain` setting: a known region name
 * (`"feishu"` | `"lark"`) or a full custom base URL for a private /
 * on-prem deployment. The `string & {}` keeps the literal names visible
 * in IDE autocomplete without collapsing the union to plain `string`.
 */
export type LarkDomainInput = LarkDomainName | (string & {});

export const DEFAULT_LARK_DOMAIN: LarkDomainName = "feishu";

const DOMAIN_BY_NAME = {
  feishu: Lark.Domain.Feishu,
  lark: Lark.Domain.Lark,
} as const satisfies Record<LarkDomainName, Lark.Domain>;

export function isLarkDomainName(value: string): value is LarkDomainName {
  return (LARK_DOMAINS as readonly string[]).includes(value);
}

/**
 * Resolve a user-supplied domain setting into the value the SDK expects.
 *
 * Accepts a known region name (`"feishu"` | `"lark"`) or a full custom
 * base URL for a private / on-prem deployment (e.g.
 * `https://open.example.com`), which is passed to the SDK verbatim.
 */
export function resolveLarkDomain(value: LarkDomainInput): Lark.Domain | string {
  if (isLarkDomainName(value)) return DOMAIN_BY_NAME[value];
  return value;
}
