import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRAPH_BASE_URL,
  DEFAULT_M365_COPILOT_SCOPES,
  SnapshotDeltaTracker,
  SseParser,
  buildChatRequestBody,
  cleanResponseText,
  describeGraphFailure,
  extractResponseMessage,
  loadConfig,
  parseConversationSnapshot,
  renderAttributions,
  splitAtSafeBoundary,
  validateConfig,
} from "./m365-copilot-acp-core.js";

const LOGIN_COMMAND = "lark-acp-m365 login";

describe("loadConfig", () => {
  it("uses the beta Graph endpoint and full scope set by default", () => {
    const config = loadConfig({ M365_COPILOT_TIMEZONE: "Asia/Shanghai" });
    expect(config.baseUrl).toBe(DEFAULT_GRAPH_BASE_URL);
    expect(config.scopes).toEqual(DEFAULT_M365_COPILOT_SCOPES);
    expect(config.streaming).toBe(true);
    expect(config.timeZone).toBe("Asia/Shanghai");
  });

  it("strips a trailing slash from the base URL", () => {
    expect(loadConfig({ M365_COPILOT_BASE_URL: "http://127.0.0.1:1/beta/" }).baseUrl).toBe(
      "http://127.0.0.1:1/beta",
    );
  });
});

describe("validateConfig", () => {
  it("requires tenant and client id unless a static token is provided", () => {
    expect(validateConfig(loadConfig({})).join(" ")).toContain("M365_COPILOT_TENANT_ID");
    expect(validateConfig(loadConfig({ M365_COPILOT_STATIC_TOKEN: "t" }))).toEqual([]);
  });
});

describe("buildChatRequestBody", () => {
  it("includes the message text and required locationHint", () => {
    expect(buildChatRequestBody("hi", "Asia/Shanghai")).toEqual({
      message: { text: "hi" },
      locationHint: { timeZone: "Asia/Shanghai" },
    });
  });
});

describe("SseParser", () => {
  it("parses events split across arbitrary chunk boundaries", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    const events = parser.push(':1}\nid:7\n\ndata: {"b":2}\n\n');
    expect(events).toEqual([
      { event: null, data: '{"a":1}' },
      { event: null, data: '{"b":2}' },
    ]);
  });

  it("joins multi-line data and reads event names", () => {
    const parser = new SseParser();
    const events = parser.push("event: activity\ndata: line1\ndata: line2\n\n");
    expect(events).toEqual([{ event: "activity", data: "line1\nline2" }]);
  });

  it("normalizes CRLF and flushes a trailing block on end()", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"x":1}\r\n')).toEqual([]);
    expect(parser.end()).toEqual([{ event: null, data: '{"x":1}' }]);
  });
});

describe("snapshot extraction", () => {
  const snapshot = parseConversationSnapshot(
    JSON.stringify({
      id: "conv-1",
      state: "active",
      messages: [
        { "@odata.type": "#microsoft.graph.copilotConversationResponseMessage", text: "问题原文" },
        {
          "@odata.type": "#microsoft.graph.copilotConversationResponseMessage",
          text: "这是回答",
          attributions: [
            {
              attributionType: "citation",
              providerDisplayName: "季度报告.docx",
              seeMoreWebUrl: "https://contoso.sharepoint.com/report",
            },
            { attributionType: "annotation", seeMoreWebUrl: "https://ignored.example.com" },
          ],
        },
      ],
    }),
  );

  it("skips the echoed user prompt and returns the last reply", () => {
    const message = extractResponseMessage(snapshot, "问题原文");
    expect(message?.text).toBe("这是回答");
  });

  it("returns null when only the prompt echo is present", () => {
    const echoOnly = parseConversationSnapshot(
      JSON.stringify({ messages: [{ text: "问题原文" }] }),
    );
    expect(extractResponseMessage(echoOnly, "问题原文")).toBeNull();
  });

  it("renders citation attributions as a numbered markdown list", () => {
    const rendered = renderAttributions(extractResponseMessage(snapshot, "问题原文"));
    expect(rendered).toContain("**Sources**");
    expect(rendered).toContain("[季度报告.docx](https://contoso.sharepoint.com/report)");
    expect(rendered).not.toContain("ignored.example.com");
  });

  it("renders nothing without citations", () => {
    expect(renderAttributions(null)).toBe("");
  });
});

describe("cleanResponseText", () => {
  it("strips documented pseudo-entity tags and normalizes footnote markers", () => {
    expect(cleanResponseText("会议：<Event>周会</Event>，组织者 <Person>张三</Person>[^1^]")).toBe(
      "会议：周会，组织者 张三[1]",
    );
    expect(cleanResponseText("文档 <File>Plan.docx</File>[^external^]")).toBe(
      "文档 Plan.docx[external]",
    );
  });

  it("leaves ordinary markdown untouched", () => {
    const text = "**bold** [link](https://example.com) `a < b`";
    expect(cleanResponseText(text)).toBe(text);
  });
});

describe("splitAtSafeBoundary", () => {
  it("holds back an incomplete tag", () => {
    expect(splitAtSafeBoundary("hello <Per")).toEqual({ emit: "hello ", hold: "<Per" });
  });

  it("holds back an incomplete footnote marker", () => {
    expect(splitAtSafeBoundary("done[^1")).toEqual({ emit: "done", hold: "[^1" });
  });

  it("emits everything when tokens are complete", () => {
    expect(splitAtSafeBoundary("a <Person>x</Person> [^1^] b")).toEqual({
      emit: "a <Person>x</Person> [^1^] b",
      hold: "",
    });
  });
});

describe("SnapshotDeltaTracker", () => {
  it("emits cleaned deltas from cumulative snapshots", () => {
    const tracker = new SnapshotDeltaTracker();
    // "<Event>" is complete → emitted right away (and stripped); the closing
    // "</Event>" arrives in the next snapshot and is stripped there.
    expect(tracker.advance("会议是 <Event>周会")).toBe("会议是 周会");
    expect(tracker.advance("会议是 <Event>周会</Event>，明早九点")).toBe("，明早九点");
    expect(tracker.finalize()).toBe("");
    expect(tracker.hasOutput).toBe(true);
  });

  it("holds an incomplete tag across snapshots so cleanup never sees a torn token", () => {
    const tracker = new SnapshotDeltaTracker();
    expect(tracker.advance("组织者 <Per")).toBe("组织者 ");
    expect(tracker.advance("组织者 <Person>张三</Person>好")).toBe("张三好");
  });

  it("ignores regressed snapshots and flushes held text on finalize", () => {
    const tracker = new SnapshotDeltaTracker();
    expect(tracker.advance("答案 [^1")).toBe("答案 ");
    expect(tracker.advance("不同的前缀")).toBe("");
    // The marker never completed, so the raw remainder is flushed untouched.
    expect(tracker.finalize()).toBe("[^1");
  });

  it("reports no output for an empty stream", () => {
    const tracker = new SnapshotDeltaTracker();
    expect(tracker.finalize()).toBe("");
    expect(tracker.hasOutput).toBe(false);
  });
});

describe("describeGraphFailure", () => {
  it("marks 401 and 403 as authentication failures", () => {
    expect(describeGraphFailure(401, "", LOGIN_COMMAND)).toMatch(/^Authentication required/);
    const forbidden = describeGraphFailure(403, "", LOGIN_COMMAND);
    expect(forbidden).toMatch(/^Authentication required/);
    expect(forbidden).toContain("license");
  });

  it("suggests /new on 404 and includes the body tail", () => {
    const msg = describeGraphFailure(404, "gone", LOGIN_COMMAND);
    expect(msg).toContain("/new");
    expect(msg).toContain("gone");
  });
});
