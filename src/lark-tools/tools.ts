import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tool-context.js";
import { AskTimeoutError } from "./tool-context.js";

/** Tool names exposed to the agent (stable identifiers). */
export const LARK_TOOL_NAMES = {
  askChoice: "lark_ask_choice",
  downloadFile: "lark_download_message_file",
} as const;

// Guardrails on interactive input — a runaway agent must not spam a
// 50-button card or an empty prompt.
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MAX_QUESTION_CHARS = 2_000;
// Lark tool results are display-oriented; cap a downloaded blob so a huge
// file can't blow the agent's context or the MCP payload.
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Register the curated Lark tool set on `server`, bound to one chat's
 * {@link ToolContext}. Kept intentionally small (plan / design §3) so the
 * per-session tool schema stays light.
 */
export function registerLarkTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    LARK_TOOL_NAMES.askChoice,
    {
      title: "Ask the Lark user to choose",
      description:
        "Send an interactive card to the current Lark chat asking the user to pick one of " +
        "the given options, and block until they choose. Use when you need a decision from " +
        "the user before continuing.",
      inputSchema: {
        question: z.string().min(1).max(MAX_QUESTION_CHARS),
        options: z.array(z.string().min(1)).min(MIN_OPTIONS).max(MAX_OPTIONS),
      },
    },
    async ({ question, options }) => {
      try {
        const result = await ctx.askChoice(question, options);
        return { content: [{ type: "text", text: result.label }] };
      } catch (err) {
        const message = err instanceof AskTimeoutError ? err.message : formatError(err);
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  server.registerTool(
    LARK_TOOL_NAMES.downloadFile,
    {
      title: "Download a Lark message attachment",
      description:
        "Download the bytes of a file or image the user attached to a message, referenced by " +
        "its message_id and file_key (as surfaced in the message placeholder).",
      inputSchema: {
        messageId: z.string().min(1),
        fileKey: z.string().min(1),
        type: z.enum(["image", "file"]).default("file"),
      },
    },
    async ({ messageId, fileKey, type }) => {
      try {
        const { bytes, mimeType } = await ctx.downloadMessageFile(messageId, fileKey, type);
        if (bytes.length > MAX_DOWNLOAD_BYTES) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `file too large (${String(bytes.length)} bytes > ${String(MAX_DOWNLOAD_BYTES)} limit)`,
              },
            ],
          };
        }
        const data = bytes.toString("base64");
        if (type === "image") {
          return { content: [{ type: "image", data, mimeType }] };
        }
        return {
          content: [
            {
              type: "resource",
              resource: { uri: `lark-file://${fileKey}`, mimeType, blob: data },
            },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: formatError(err) }] };
      }
    },
  );
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
