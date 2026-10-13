/**
 * Structured, tenant-tagged audit trail (Phase-2 groundwork, architecture
 * plan §4.4 / §6). Security-relevant events — access decisions, allowlist
 * mutations, tool authorizations — flow through {@link AuditLogger} rather
 * than ad-hoc log calls, so a hosted deployment can route them to a separate,
 * retained sink per tenant without touching the bridge.
 *
 * The default {@link LoggerAuditLogger} writes through the existing structured
 * logger with an `audit: true` marker and the tenant id, preserving today's
 * behaviour.
 */

import type { LarkLogger } from "../logger/logger.js";

/** A single audit record. `action` is a stable dotted key (e.g. `access.denied`). */
export interface AuditEvent {
  readonly action: string;
  readonly chatId?: string;
  /** Lark `open_id` of the acting user, when applicable. */
  readonly operatorOpenId?: string;
  /** Coarse result, e.g. `allowed` / `denied` / `granted` / `revoked`. */
  readonly outcome?: string;
  /** Extra structured context (role, reason, target, request id, …). */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface AuditLogger {
  /** Record one audit event. Never throws. */
  record(event: AuditEvent): void;
}

/** {@link AuditLogger} that emits through a {@link LarkLogger}. */
export class LoggerAuditLogger implements AuditLogger {
  private readonly logger: LarkLogger;
  private readonly tenantId: string;

  constructor(logger: LarkLogger, tenantId: string) {
    this.logger = logger.child({ name: "audit", tenantId });
    this.tenantId = tenantId;
  }

  record(event: AuditEvent): void {
    const { action, detail, ...rest } = event;
    this.logger.info(
      { audit: true, tenantId: this.tenantId, action, ...rest, ...(detail ?? {}) },
      `audit:${action}`,
    );
  }
}
