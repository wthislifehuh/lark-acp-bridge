import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SessionRecord, SessionStore } from "./session-store.js";

const SESSIONS_FILE_NAME = "sessions.json";

const sessionRecordSchema: z.ZodType<SessionRecord> = z.object({
  chatId: z.string(),
  sessionId: z.string(),
  label: z.string().optional(),
  agentCommand: z.string(),
  agentArgs: z.array(z.string()),
  cwd: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** Pre-multi-session legacy on-disk shape: one bare record per chat. */
const legacyRecordSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  updatedAt: z.number(),
});

/**
 * JSON-file backed {@link SessionStore}. Writes are coalesced via
 * `setImmediate` so a burst of `save()` calls produces one fsync.
 */
export class FileSessionStore implements SessionStore {
  private readonly filePath: string;
  private readonly data = new Map<string, SessionRecord[]>();
  private flushScheduled = false;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, SESSIONS_FILE_NAME);
  }

  // The SessionStore interface is async for the sake of database-backed
  // implementations; this file-backed one is fully synchronous, so methods
  // return already-resolved promises instead of being `async`.

  init(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return Promise.resolve();

    let parsed: unknown;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt file — treat as empty rather than crashing.
      return Promise.resolve();
    }

    const topLevel = z.record(z.string(), z.unknown()).safeParse(parsed);
    if (!topLevel.success) return Promise.resolve();

    // Entries are validated individually and invalid ones skipped, so one
    // malformed record (hand edit, older version) doesn't wipe the rest.
    let migratedLegacy = false;
    for (const [chatId, value] of Object.entries(topLevel.data)) {
      if (Array.isArray(value)) {
        const records = value.flatMap((entry): SessionRecord[] => {
          const result = sessionRecordSchema.safeParse(entry);
          return result.success ? [result.data] : [];
        });
        if (records.length > 0) this.data.set(chatId, records);
        continue;
      }

      const legacy = legacyRecordSchema.safeParse(value);
      if (!legacy.success) continue;
      this.data.set(chatId, [
        {
          chatId,
          sessionId: legacy.data.sessionId,
          agentCommand: "",
          agentArgs: [],
          cwd: legacy.data.cwd,
          createdAt: legacy.data.updatedAt,
          updatedAt: legacy.data.updatedAt,
        },
      ]);
      migratedLegacy = true;
    }
    if (migratedLegacy) this.scheduleFlush();
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.flushScheduled) this.flush();
    return Promise.resolve();
  }

  listByChat(chatId: string): Promise<readonly SessionRecord[]> {
    const records = this.data.get(chatId);
    if (!records) return Promise.resolve([]);
    return Promise.resolve([...records].sort((a, b) => b.updatedAt - a.updatedAt));
  }

  getLatest(chatId: string): Promise<SessionRecord | null> {
    const records = this.data.get(chatId);
    if (!records?.length) return Promise.resolve(null);
    return Promise.resolve(records.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b)));
  }

  save(record: SessionRecord): Promise<void> {
    let records = this.data.get(record.chatId);
    if (!records) {
      records = [];
      this.data.set(record.chatId, records);
    }
    const idx = records.findIndex((r) => r.sessionId === record.sessionId);
    if (idx >= 0) records[idx] = record;
    else records.push(record);
    this.scheduleFlush();
    return Promise.resolve();
  }

  delete(chatId: string, sessionId: string): Promise<void> {
    const records = this.data.get(chatId);
    if (!records) return Promise.resolve();
    const idx = records.findIndex((r) => r.sessionId === sessionId);
    if (idx < 0) return Promise.resolve();
    records.splice(idx, 1);
    if (!records.length) this.data.delete(chatId);
    this.scheduleFlush();
    return Promise.resolve();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flush();
    });
  }

  /** Write the in-memory state to disk via tmp-file + rename, guarding against a crash mid-write. */
  private flush(): void {
    this.flushScheduled = false;
    const obj: Record<string, SessionRecord[]> = {};
    for (const [chatId, records] of this.data) {
      obj[chatId] = records;
    }
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.filePath);
  }
}
