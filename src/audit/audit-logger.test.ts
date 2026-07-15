/**
 * White-box unit tests for the tenant-tagged audit logger (Phase-2
 * groundwork). Verifies records carry the `audit` marker, tenant id, action,
 * and flattened detail.
 */

import { describe, expect, it } from "vitest";
import { LoggerAuditLogger } from "./audit-logger.js";
import type { LarkLogger } from "../logger/logger.js";

interface Call {
  readonly obj: Record<string, unknown>;
  readonly msg?: string;
}

function makeFakeLogger(sink: Call[]): LarkLogger {
  const logger: LarkLogger = {
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    info: (objOrMsg: object | string, msg?: string) => {
      if (typeof objOrMsg === "string") sink.push({ obj: {}, msg: objOrMsg });
      else sink.push({ obj: objOrMsg as Record<string, unknown>, msg });
    },
    child: () => logger,
  };
  return logger;
}

describe("LoggerAuditLogger", () => {
  it("tags records with audit, tenant id, action and message", () => {
    const sink: Call[] = [];
    const audit = new LoggerAuditLogger(makeFakeLogger(sink), "tenant-a");

    audit.record({
      action: "access.denied",
      chatId: "oc_1",
      operatorOpenId: "ou_x",
      outcome: "denied",
      detail: { reason: "not_allowed_user" },
    });

    expect(sink).toHaveLength(1);
    const [call] = sink;
    expect(call?.msg).toBe("audit:access.denied");
    expect(call?.obj).toMatchObject({
      audit: true,
      tenantId: "tenant-a",
      action: "access.denied",
      chatId: "oc_1",
      operatorOpenId: "ou_x",
      outcome: "denied",
      // detail is flattened into the record
      reason: "not_allowed_user",
    });
  });

  it("works without optional fields", () => {
    const sink: Call[] = [];
    const audit = new LoggerAuditLogger(makeFakeLogger(sink), "default");
    audit.record({ action: "access.command_denied", operatorOpenId: "ou_y", outcome: "denied" });

    expect(sink[0]?.obj).toMatchObject({
      audit: true,
      tenantId: "default",
      action: "access.command_denied",
    });
    expect(sink[0]?.obj.chatId).toBeUndefined();
  });
});
