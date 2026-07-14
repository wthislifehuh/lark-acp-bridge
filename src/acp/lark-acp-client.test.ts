/**
 * White-box unit tests for {@link LarkAcpClient} permission-card
 * authorization — the second Phase-1 enforcement point (architecture plan
 * §4.1): only the operator whose prompt triggered a permission request (or
 * a privileged user) may resolve its card.
 */

import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { LarkAcpClient } from "./lark-acp-client.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import type { LarkLogger } from "../logger/logger.js";

const noopLogger: LarkLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const OPERATOR = "ou_operator";
const OTHER = "ou_other";
const ADMIN = "ou_admin";

const PERMISSION_PARAMS: acp.RequestPermissionRequest = {
  sessionId: "sess_1",
  toolCall: { toolCallId: "tc_1", title: "write file" },
  options: [
    { optionId: "allow", kind: "allow_once", name: "允许" },
    { optionId: "reject", kind: "reject_once", name: "拒绝" },
  ],
};

/**
 * A presenter double that captures the `requestId` the client generates
 * (the bridge normally learns it from the card payload) and hands back a
 * stub card message id.
 */
function makePresenter(): { presenter: LarkPresenter; requestId: () => string } {
  let captured = "";
  const presenter = {
    replyText: vi.fn(() => Promise.resolve()),
    addReaction: vi.fn(() => Promise.resolve<string | null>("r1")),
    removeReaction: vi.fn(() => Promise.resolve()),
    sendInterruptCard: vi.fn((_m: string, _p, requestId: string) => {
      captured = requestId;
      return Promise.resolve<string | null>("card_1");
    }),
    updatePermissionCard: vi.fn(() => Promise.resolve()),
    expirePermissionCard: vi.fn(() => Promise.resolve()),
    replyNoticeCard: vi.fn(() => Promise.resolve()),
    sendUnifiedCard: vi.fn(() => Promise.resolve<string | null>("u1")),
    updateUnifiedCard: vi.fn(() => Promise.resolve()),
  } satisfies LarkPresenter;
  return { presenter, requestId: () => captured };
}

function makeClient(presenter: LarkPresenter): LarkAcpClient {
  return new LarkAcpClient({
    presenter,
    logger: noopLogger,
    agentCwd: process.cwd(),
    showThoughts: true,
    showTools: true,
    showCancelButton: true,
    permissionTimeoutMs: 0,
    permissionMode: "alwaysAsk",
    callbacks: { onTyping: () => Promise.resolve() },
  });
}

/** Wait for the pending permission to register (sendInterruptCard resolves). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("LarkAcpClient permission-card authorization", () => {
  it("rejects a click from a non-operator and keeps the request pending", async () => {
    const { presenter, requestId } = makePresenter();
    const client = makeClient(presenter);
    client.setContext("msg_1", "chat_1", OPERATOR);

    const pending = client.requestPermission(PERMISSION_PARAMS);
    await flush();
    const id = requestId();

    const forbidden = client.handleCardAction(id, "allow", {
      openId: OTHER,
      privileged: false,
    });
    expect(forbidden).toBe("forbidden");

    // The request is still resolvable by the real operator.
    const resolved = client.handleCardAction(id, "allow", {
      openId: OPERATOR,
      privileged: false,
    });
    expect(resolved).toBe("resolved");
    await expect(pending).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("lets a privileged (owner/admin) user resolve another operator's card", async () => {
    const { presenter, requestId } = makePresenter();
    const client = makeClient(presenter);
    client.setContext("msg_1", "chat_1", OPERATOR);

    const pending = client.requestPermission(PERMISSION_PARAMS);
    await flush();

    const resolved = client.handleCardAction(requestId(), "reject", {
      openId: ADMIN,
      privileged: true,
    });
    expect(resolved).toBe("resolved");
    await expect(pending).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });

  it("reports an unknown request id as orphan", () => {
    const { presenter } = makePresenter();
    const client = makeClient(presenter);
    expect(client.handleCardAction("nope", "allow", { openId: OPERATOR, privileged: false })).toBe(
      "orphan",
    );
  });
});
