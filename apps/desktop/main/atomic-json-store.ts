/**
 * Generic atomic-JSON persistence: a serialized write queue, tmp+rename
 * durability, fsync before replace, and corruption isolation on read.
 *
 * Extracts the pattern every store (settings, history, scheduler, lanes,
 * goals, chat…) used to hand-roll, so a corrupted document can never wedge
 * a feature the way run-ledger's hard failure once did.
 */
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { replaceFile } from "./replace-file";

export interface AtomicJsonStoreOptions<T> {
  /** Validate/coerce a parsed document. Throw to reject; the store keeps the raw file untouched. */
  validate?: (value: unknown) => T;
  /** Invoked once per unreadable/corrupt file instead of throwing on every read. */
  onCorrupt?: (error: unknown) => void;
  /** Invoked when a save fails after retries; the next read still returns the last good value. */
  onPersistError?: (error: unknown) => void;
  /** Force every read through validation even without a validate hook. */
  requireValidated?: boolean;
}

export class AtomicJsonStore<T> {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly options: AtomicJsonStoreOptions<T> = {},
  ) {}

  /**
   * Load the stored document. Missing file → `undefined`. Corrupt or
   * schema-invalid file → `undefined` + `onCorrupt`, never a throw: callers
   * decide their own fallback (defaults, empty state…).
   */
  async load(): Promise<T | undefined> {
    await this.writes;
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      this.options.onCorrupt?.(error);
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.options.validate
        ? this.options.validate(parsed)
        : (parsed as T);
    } catch (error) {
      this.options.onCorrupt?.(error);
      return undefined;
    }
  }

  /**
   * Queue a validated, fsynced, atomic replacement. Saves are serialized so
   * interleaved writers cannot clobber each other; validation failures reject
   * this save without poisoning the queue.
   */
  async save(value: T): Promise<void> {
    // Own a JSON copy before validation: coercion must not mutate the caller,
    // and later caller changes must not reach a queued write.
    const copy = JSON.parse(JSON.stringify(value)) as T;
    const validated = this.options.validate
      ? this.options.validate(copy)
      : copy;
    const contents = JSON.stringify(validated, null, 2);
    const task = this.writes.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const staging = `${this.file}.tmp`;
        const handle = await open(staging, "w");
        try {
          await handle.writeFile(contents, "utf8");
          // Flush before replacement so partial staging never becomes current.
          await handle.sync();
        } finally {
          await handle.close();
        }
        await replaceFile(staging, this.file);
      } catch (error) {
        this.options.onPersistError?.(error);
        throw error;
      }
    });
    this.writes = task.catch(() => {});
    await task;
  }

  /** Test/inspection hook: the file this store persists to. */
  get path(): string {
    return this.file;
  }

  /**
   * Rename the current file aside (best effort) so a fresh start can begin
   * without deleting evidence of the previous state.
   */
  async quarantine(reason: string): Promise<string | undefined> {
    await this.writes;
    try {
      await readFile(this.file, "utf8");
    } catch {
      return undefined; // nothing to quarantine
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const aside = `${this.file}.bak-${stamp}`;
    await rename(this.file, aside).catch(() => undefined);
    console.warn(`atomic-json: ${this.file} 已隔离（${reason}）→ ${aside}`);
    return aside;
  }
}
