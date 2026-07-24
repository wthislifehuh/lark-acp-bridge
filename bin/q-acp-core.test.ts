import { describe, expect, it } from "vitest";
import {
  buildQArgs,
  buildQInput,
  capHistory,
  flattenPrompt,
  isQAuthFailure,
  loadConfig,
  parseTranscriptFile,
  sessionFilePath,
  stripAnsi,
  CURRENT_HEADER,
  DEFAULT_MAX_HISTORY_CHARS,
  DEFAULT_MAX_HISTORY_MESSAGES,
  HISTORY_HEADER,
  type QAdapterConfig,
  type TranscriptMessage,
} from "./q-acp-core.js";

const ESC = String.fromCharCode(27);

const BASE_CONFIG: QAdapterConfig = {
  bin: "q",
  model: null,
  agent: null,
  trustTools: null,
  wrap: "never",
  extraArgs: [],
  dataDir: "/tmp/q-sessions",
  maxHistoryMessages: DEFAULT_MAX_HISTORY_MESSAGES,
  maxHistoryChars: DEFAULT_MAX_HISTORY_CHARS,
};

describe("stripAnsi", () => {
  it("removes SGR colour codes", () => {
    expect(stripAnsi(`${ESC}[36mhello${ESC}[0m world`)).toBe("hello world");
  });

  it("removes 256-colour and cursor sequences", () => {
    expect(stripAnsi(`${ESC}[38;5;141m> ${ESC}[0mHELLO${ESC}[2K`)).toBe("> HELLO");
  });

  it("leaves plain text and markdown untouched", () => {
    const text = "# title\n- item `code` **bold**";
    expect(stripAnsi(text)).toBe(text);
  });
});

describe("flattenPrompt", () => {
  it("joins text blocks with newlines and trims", () => {
    expect(
      flattenPrompt([
        { type: "text", text: "[上下文]" },
        { type: "text", text: "hello " },
      ]),
    ).toBe("[上下文]\nhello");
  });

  it("lowers non-text blocks into placeholders", () => {
    const flattened = flattenPrompt([
      { type: "text", text: "look:" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
    expect(flattened).toContain("look:");
    expect(flattened).toContain("[image content omitted]");
  });
});

describe("buildQInput", () => {
  it("returns raw text when there is no history", () => {
    expect(buildQInput([], "hi")).toBe("hi");
  });

  it("replays history under the header, current request last", () => {
    const transcript: TranscriptMessage[] = [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
    ];
    const input = buildQInput(transcript, "q2");
    expect(input.startsWith(HISTORY_HEADER)).toBe(true);
    expect(input).toContain("User: q1");
    expect(input).toContain("Assistant: a1");
    expect(input.indexOf(CURRENT_HEADER)).toBeGreaterThan(input.indexOf("a1"));
    expect(input.endsWith("q2")).toBe(true);
  });
});

describe("capHistory", () => {
  const msg = (role: "user" | "assistant", text: string): TranscriptMessage => ({ role, text });

  it("keeps everything under both caps", () => {
    const t = [msg("user", "a"), msg("assistant", "b")];
    expect(capHistory(t, 10, 1000)).toEqual(t);
  });

  it("enforces the message cap, newest first, without a leading assistant reply", () => {
    const t = [
      msg("user", "q1"),
      msg("assistant", "a1"),
      msg("user", "q2"),
      msg("assistant", "a2"),
    ];
    // cap=3 keeps [a1, q2, a2] → leading assistant dropped → [q2, a2]
    expect(capHistory(t, 3, 1000)).toEqual([msg("user", "q2"), msg("assistant", "a2")]);
  });

  it("enforces the character budget", () => {
    const t = [msg("user", "x".repeat(100)), msg("user", "y".repeat(100))];
    const kept = capHistory(t, 10, 150);
    expect(kept).toEqual([msg("user", "y".repeat(100))]);
  });

  it("drops all history when the newest message alone exceeds the budget", () => {
    const t = [msg("user", "small"), msg("assistant", "z".repeat(500))];
    expect(capHistory(t, 10, 100)).toEqual([]);
  });
});

describe("buildQArgs", () => {
  it("builds the default invocation with all tools trusted", () => {
    expect(buildQArgs(BASE_CONFIG, "hello")).toEqual([
      "chat",
      "--no-interactive",
      "--wrap",
      "never",
      "--trust-all-tools",
      "--",
      "hello",
    ]);
  });

  it("switches to --trust-tools when a CSV is configured", () => {
    const args = buildQArgs({ ...BASE_CONFIG, trustTools: "fs_read,fs_write" }, "x");
    expect(args).toContain("--trust-tools");
    expect(args).toContain("fs_read,fs_write");
    expect(args).not.toContain("--trust-all-tools");
  });

  it("omits --wrap when configured empty, appends model/agent/extra args", () => {
    const args = buildQArgs(
      { ...BASE_CONFIG, wrap: "", model: "m1", agent: "dev", extraArgs: ["--verbose"] },
      "x",
    );
    expect(args).not.toContain("--wrap");
    expect(args).toEqual(expect.arrayContaining(["--model", "m1", "--agent", "dev", "--verbose"]));
  });

  it("keeps the prompt as the final positional after --", () => {
    const args = buildQArgs(BASE_CONFIG, "--not-a-flag");
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("--not-a-flag");
  });
});

describe("loadConfig", () => {
  it("applies defaults with an empty environment", () => {
    const config = loadConfig({});
    expect(config.bin).toBe("q");
    expect(config.wrap).toBe("never");
    expect(config.trustTools).toBeNull();
    expect(config.maxHistoryMessages).toBe(DEFAULT_MAX_HISTORY_MESSAGES);
    expect(config.maxHistoryChars).toBe(DEFAULT_MAX_HISTORY_CHARS);
  });

  it("reads overrides and treats empty Q_ACP_WRAP as omit-the-flag", () => {
    const config = loadConfig({
      Q_ACP_BIN: "/usr/local/bin/q",
      Q_ACP_MODEL: "claude-sonnet-4",
      Q_ACP_WRAP: "",
      Q_ACP_EXTRA_ARGS: "  --foo   bar ",
      Q_ACP_MAX_HISTORY: "6",
      Q_ACP_MAX_HISTORY_CHARS: "5000",
    });
    expect(config.bin).toBe("/usr/local/bin/q");
    expect(config.model).toBe("claude-sonnet-4");
    expect(config.wrap).toBe("");
    expect(config.extraArgs).toEqual(["--foo", "bar"]);
    expect(config.maxHistoryMessages).toBe(6);
    expect(config.maxHistoryChars).toBe(5000);
  });

  it("falls back to defaults on non-positive or garbage numeric envs", () => {
    const config = loadConfig({ Q_ACP_MAX_HISTORY: "-3", Q_ACP_MAX_HISTORY_CHARS: "lots" });
    expect(config.maxHistoryMessages).toBe(DEFAULT_MAX_HISTORY_MESSAGES);
    expect(config.maxHistoryChars).toBe(DEFAULT_MAX_HISTORY_CHARS);
  });
});

describe("sessionFilePath", () => {
  it("sanitises non-UUID characters", () => {
    const file = sessionFilePath("/data", "../evil/../../id");
    expect(file).not.toContain("..");
    expect(file.endsWith(".json")).toBe(true);
  });
});

describe("parseTranscriptFile", () => {
  it("round-trips a valid payload", () => {
    const raw = JSON.stringify({
      version: 1,
      transcript: [{ role: "user", text: "hi" }],
    });
    expect(parseTranscriptFile(raw)).toEqual([{ role: "user", text: "hi" }]);
  });

  it.each([
    ["not json", "{oops"],
    ["wrong version", JSON.stringify({ version: 99, transcript: [] })],
    ["malformed entries", JSON.stringify({ version: 1, transcript: [{ role: "robot" }] })],
  ])("throws on %s", (_name, raw) => {
    expect(() => parseTranscriptFile(raw)).toThrow();
  });
});

describe("isQAuthFailure", () => {
  it("detects q login failures", () => {
    expect(isQAuthFailure(["Error: You are not logged in. Run `q login`."])).toBe(true);
    expect(isQAuthFailure(["your token has expired"])).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isQAuthFailure(["network unreachable", "429 throttled"])).toBe(false);
  });
});
