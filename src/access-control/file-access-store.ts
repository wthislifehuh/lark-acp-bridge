import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ACCESS_STATE,
  accessStateSchema,
  type AccessState,
  type AccessStore,
} from "./access-store.js";

const ACCESS_FILE_NAME = "access.json";

/**
 * JSON-file backed {@link AccessStore}. State is loaded once at
 * {@link init} and kept in memory; {@link save} coalesces writes via
 * `setImmediate` and persists atomically (tmp file + rename) so a crash
 * mid-write can't corrupt the allowlists.
 */
export class FileAccessStore implements AccessStore {
  private readonly filePath: string;
  private state: AccessState = DEFAULT_ACCESS_STATE;
  private pending: AccessState | null = null;
  private flushScheduled = false;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, ACCESS_FILE_NAME);
  }

  // The AccessStore interface is async for the sake of future
  // database-backed implementations; this file-backed one loads
  // synchronously, so `init` returns an already-resolved promise.

  init(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return Promise.resolve();

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      // Corrupt file — start from the default rather than crashing.
      return Promise.resolve();
    }

    const result = accessStateSchema.safeParse(parsed);
    if (result.success) this.state = result.data;
    return Promise.resolve();
  }

  load(): AccessState {
    return this.state;
  }

  save(state: AccessState): void {
    this.state = state;
    this.pending = state;
    this.scheduleFlush();
  }

  close(): Promise<void> {
    if (this.pending) this.flush();
    return Promise.resolve();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flush();
    });
  }

  /** Write in-memory state via tmp-file + rename, guarding against a crash mid-write. */
  private flush(): void {
    this.flushScheduled = false;
    const state = this.pending;
    if (!state) return;
    this.pending = null;
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.filePath);
  }
}
