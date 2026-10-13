/**
 * Session persistence shared by the Microsoft adapters
 * (`lark-acp-copilot-studio`, `lark-acp-m365`).
 *
 * Both backends keep the transcript server-side, so resuming after a bridge
 * restart only needs the upstream conversation id, stored per ACP session id.
 */

import path from "node:path";
import { z } from "zod";

export const CONVERSATION_SESSION_FILE_VERSION = 1 as const;
export const SESSION_FILE_EXT = ".json";

const conversationSessionFileSchema = z.object({
  version: z.literal(CONVERSATION_SESSION_FILE_VERSION),
  sessionId: z.string(),
  conversationId: z.string().nullable(),
  updatedAt: z.number(),
});

export type ConversationSessionFile = z.infer<typeof conversationSessionFileSchema>;

export function sessionFilePath(dataDir: string, sessionId: string): string {
  // Session ids are UUIDs we mint, but sanitise defensively before touching FS.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(dataDir, "sessions", `${safe}${SESSION_FILE_EXT}`);
}

/**
 * Parse a persisted session file.
 *
 * @throws when the payload is not valid JSON or does not match the expected
 *         shape — the caller treats this as "no resumable session".
 */
export function parseConversationSessionFile(raw: string): ConversationSessionFile {
  return conversationSessionFileSchema.parse(JSON.parse(raw));
}
