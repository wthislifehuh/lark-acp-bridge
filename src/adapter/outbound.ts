/**
 * Outbound adapter — format ACP reply text for Feishu's markdown element.
 *
 * Feishu's `markdown` element supports most GFM syntax but:
 *   - Tables are NOT supported → wrapped in ```text code blocks
 *   - Code blocks without language identifiers → default to ```text
 *   - Code blocks need blank line separation
 */

const MAX_MESSAGE_LENGTH = 4000;

/** Sentinel regex: detects markdown table rows (starts/ends with |, has separator row) */
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export function formatForFeishu(text: string): string {
  let out = text.trim();

  // Fix code blocks: add `text` language to bare ``` blocks
  out = out.replace(/^```\s*$/gm, "```text");

  // Wrap markdown tables in ```text code blocks
  out = wrapTables(out);

  return out;
}

function wrapTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inTable = false;
  let tableLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableRow = line.trim().startsWith("|") && line.trim().endsWith("|");
    const isSeparator = TABLE_SEPARATOR.test(line.trim());

    if (isTableRow || (isSeparator && i > 0 && lines[i - 1]?.trim().startsWith("|"))) {
      if (!inTable) {
        inTable = true;
        tableLines = [];
        // Ensure blank line before table code block
        if (result.length > 0 && result[result.length - 1] !== "") {
          result.push("");
        }
        result.push("```text");
      }
      tableLines.push(line);
    } else {
      if (inTable) {
        // End table: push accumulated lines and close code block
        result.push(...tableLines);
        result.push("```");
        result.push(""); // blank line after
        inTable = false;
        tableLines = [];
      }
      result.push(line);
    }
  }

  // Close trailing table
  if (inTable) {
    result.push(...tableLines);
    result.push("```");
  }

  return result.join("\n");
}

/** Split long responses into chunks that fit within Feishu's limit. */
export function splitText(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    // Try to split at a code block boundary first, then newline
    let splitAt = remaining.lastIndexOf("\n```\n", limit);
    if (splitAt <= 0 || splitAt > limit) {
      splitAt = remaining.lastIndexOf("\n", limit);
    }
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
