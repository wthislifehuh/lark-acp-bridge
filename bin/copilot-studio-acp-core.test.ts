import { describe, expect, it } from "vitest";
import {
  ActivityRenderer,
  describeUpstreamFailure,
  loadConfig,
  resolveAuthMode,
  validateConfig,
  type ActivityView,
} from "./copilot-studio-acp-core.js";
import { parseConversationSessionFile, sessionFilePath } from "./session-file.js";

const LOGIN_COMMAND = "lark-acp-copilot-studio login";

function typing(text: string): ActivityView {
  return { type: "typing", text };
}

function message(text: string, extra: Partial<ActivityView> = {}): ActivityView {
  return { type: "message", text, ...extra };
}

describe("loadConfig", () => {
  it("infers auth mode from provided credentials", () => {
    expect(loadConfig({ COPILOT_STUDIO_STATIC_TOKEN: "t" }).authMode).toBe("static-token");
    expect(loadConfig({ COPILOT_STUDIO_CLIENT_SECRET: "s" }).authMode).toBe("client-secret");
    expect(loadConfig({}).authMode).toBe("device-code");
  });

  it("parses scopes as a comma-separated list", () => {
    const config = loadConfig({ COPILOT_STUDIO_SCOPES: "a, b ,,c" });
    expect(config.scopes).toEqual(["a", "b", "c"]);
  });

  it("defaults emitStartEvent to true and honours explicit false", () => {
    expect(loadConfig({}).emitStartEvent).toBe(true);
    expect(loadConfig({ COPILOT_STUDIO_EMIT_START_EVENT: "false" }).emitStartEvent).toBe(false);
  });
});

describe("resolveAuthMode", () => {
  it("rejects unknown explicit modes", () => {
    expect(() => resolveAuthMode("oauth", false, false)).toThrow(/COPILOT_STUDIO_AUTH_MODE/);
  });

  it("lets an explicit mode override inference", () => {
    expect(resolveAuthMode("device-code", true, true)).toBe("device-code");
  });
});

describe("validateConfig", () => {
  it("accepts directConnectUrl with a static token", () => {
    const config = loadConfig({
      COPILOT_STUDIO_DIRECT_CONNECT_URL: "https://example.powerplatform.com/x",
      COPILOT_STUDIO_STATIC_TOKEN: "t",
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it("requires environmentId+schemaName when no direct URL is given", () => {
    const config = loadConfig({ COPILOT_STUDIO_STATIC_TOKEN: "t" });
    expect(validateConfig(config).join(" ")).toContain("COPILOT_STUDIO_ENVIRONMENT_ID");
  });

  it("requires tenant and client id for device-code auth", () => {
    const config = loadConfig({ COPILOT_STUDIO_DIRECT_CONNECT_URL: "https://x.example.com" });
    const problems = validateConfig(config).join(" ");
    expect(problems).toContain("COPILOT_STUDIO_TENANT_ID");
    expect(problems).toContain("COPILOT_STUDIO_APP_CLIENT_ID");
  });
});

describe("ActivityRenderer", () => {
  it("emits deltas for cumulative streamed typing, then only the remainder from the final message", () => {
    const renderer = new ActivityRenderer();
    expect(renderer.render(typing("你好")).chunk).toBe("你好");
    expect(renderer.render(typing("你好，我是")).chunk).toBe("，我是");
    expect(renderer.render(message("你好，我是客服助手")).chunk).toBe("客服助手");
    expect(renderer.hasOutput).toBe(true);
  });

  it("ignores typing activities without text (pure progress signals)", () => {
    const renderer = new ActivityRenderer();
    expect(renderer.render({ type: "typing" }).chunk).toBe("");
    expect(renderer.hasOutput).toBe(false);
  });

  it("emits whole messages when nothing streamed and separates multiple messages", () => {
    const renderer = new ActivityRenderer();
    expect(renderer.render(message("第一条")).chunk).toBe("第一条");
    expect(renderer.render(message("第二条")).chunk).toBe("\n\n第二条");
  });

  it("does not duplicate text when the final message equals the streamed text", () => {
    const renderer = new ActivityRenderer();
    renderer.render(typing("完整回答"));
    expect(renderer.render(message("完整回答")).chunk).toBe("");
  });

  it("keeps the streamed text when the final message diverges", () => {
    const renderer = new ActivityRenderer();
    renderer.render(typing("流式版本"));
    expect(renderer.render(message("重写过的最终版本")).chunk).toBe("");
  });

  it("renders suggested actions and attachment placeholders", () => {
    const renderer = new ActivityRenderer();
    const out = renderer.render(
      message("请选择", {
        suggestedActions: { actions: [{ title: "查订单" }, { title: "转人工" }] },
        attachments: [{}],
      }),
    ).chunk;
    expect(out).toContain("请选择");
    expect(out).toContain("**建议选项**: 查订单 / 转人工");
    expect(out).toContain("1 个卡片附件");
  });

  it("flags endOfConversation", () => {
    const renderer = new ActivityRenderer();
    expect(renderer.render({ type: "endOfConversation" }).endOfConversation).toBe(true);
  });

  it("ignores non-text activity types", () => {
    const renderer = new ActivityRenderer();
    expect(renderer.render({ type: "event", text: "internal" }).chunk).toBe("");
    expect(renderer.render({ type: "trace" }).chunk).toBe("");
  });
});

describe("describeUpstreamFailure", () => {
  it("marks 401/403 as authentication failures the bridge recognizes", () => {
    for (const status of [401, 403]) {
      const msg = describeUpstreamFailure(
        { status, url: "https://x", bodyTail: "" },
        LOGIN_COMMAND,
      );
      expect(msg).toMatch(/^Authentication required/);
      expect(msg).toContain(LOGIN_COMMAND);
    }
  });

  it("hints at agent addressing problems on 404", () => {
    const msg = describeUpstreamFailure(
      { status: 404, url: "https://x", bodyTail: "not found" },
      LOGIN_COMMAND,
    );
    expect(msg).toContain("schemaName");
    expect(msg).toContain("not found");
  });

  it("falls back to a generic message with the status code", () => {
    expect(
      describeUpstreamFailure({ status: 500, url: "https://x", bodyTail: "" }, LOGIN_COMMAND),
    ).toContain("HTTP 500");
  });
});

describe("session files", () => {
  it("round-trips through the schema", () => {
    const raw = JSON.stringify({
      version: 1,
      sessionId: "abc",
      conversationId: "conv-1",
      updatedAt: 123,
    });
    expect(parseConversationSessionFile(raw).conversationId).toBe("conv-1");
  });

  it("rejects malformed payloads", () => {
    expect(() => parseConversationSessionFile('{"version":2}')).toThrow();
  });

  it("sanitises session ids in file paths", () => {
    expect(sessionFilePath("/data", "../evil")).not.toContain("..");
  });
});
