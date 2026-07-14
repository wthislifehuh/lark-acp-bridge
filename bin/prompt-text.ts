/**
 * Prompt-content helpers shared by the bundled ACP adapters
 * (`lark-acp-q`, `lark-acp-copilot-studio`, `lark-acp-m365`).
 */

import type * as acp from "@agentclientprotocol/sdk";

/** Flatten an ACP prompt into a single plain-text string for text-only backends. */
export function flattenPrompt(blocks: readonly acp.ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    // The Lark interpreter only ever emits text blocks (it lowers images /
    // files / etc. into text placeholders), so this is a defensive fallback.
    parts.push(`[${block.type} 内容已省略]`);
  }
  return parts.join("\n").trim();
}
