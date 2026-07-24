/**
 * Lark MCP tool server — the agent's reverse channel into Lark.
 *
 * Public façade; internal files import each other by concrete filename.
 * See `docs/lark-mcp-tool-server.md` for the design.
 */

export { LarkToolServer } from "./lark-tool-server.js";
export type { LarkToolServerOptions } from "./lark-tool-server.js";
export { ToolContext, AskTimeoutError } from "./tool-context.js";
export type { ToolContextOptions, AskChoiceResult, DownloadedResource } from "./tool-context.js";
export { registerLarkTools, LARK_TOOL_NAMES } from "./tools.js";
