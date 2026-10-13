/**
 * Transport abstraction for inbound Lark events (Phase-2 groundwork,
 * architecture plan §6). Today the only implementation is the WebSocket
 * long connection ({@link LarkWsConnection}); abstracting it behind an
 * interface lets a future ISV/webhook transport slot in beside it without
 * touching the bridge.
 *
 * The options are deliberately **transport-agnostic** — just the credentials,
 * region, logger, and the two inbound callbacks. Transport-specific tuning
 * (e.g. the WebSocket keepalive) is supplied by the concrete factory, not
 * baked into this interface.
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkDomainInput } from "./domain.js";

/** Transport-agnostic connection health snapshot. */
export interface LarkConnectionStatus {
  readonly state: string;
  readonly reconnectAttempts: number;
}

/** Common options every event transport needs. */
export interface LarkTransportOptions {
  appId: string;
  appSecret: string;
  /** Deployment region or custom base URL; see {@link LarkDomainInput}. */
  domain?: LarkDomainInput;
  logger: LarkLogger;
  onMessage: (event: Lark.RawMessageEvent) => void;
  onCardAction: (event: Lark.CardActionEvent) => void;
}

/**
 * A source of inbound Lark events. Implementations own their connection
 * lifecycle and surface a coarse health snapshot.
 */
export interface LarkTransport {
  /** Connect / begin receiving events. @throws when the connection can't be established. */
  start(): Promise<void>;
  /** Close the connection. Safe to call even if never started. */
  stop(): void;
  /** Coarse connection health, or `null` when the transport can't report it. */
  getConnectionStatus(): LarkConnectionStatus | null;
}

/**
 * Builds a {@link LarkTransport} from the transport-agnostic options. The
 * bridge's default factory produces a {@link LarkWsConnection}; a hosted /
 * ISV deployment can inject its own (e.g. a webhook receiver).
 */
export type LarkTransportFactory = (options: LarkTransportOptions) => LarkTransport;
