import fs from "node:fs";
import path from "node:path";

/** A small JSON document on disk, written atomically (temp file + rename) so a crash never leaves half a file. */
export class JsonFile<T> {
  constructor(
    readonly file: string | null,
    private readonly fallback: () => T,
  ) {}

  read(): T {
    if (!this.file || !fs.existsSync(this.file)) return this.fallback();
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as T;
    } catch {
      // A corrupt state file must not take the app down; keep a copy for inspection and start clean.
      try {
        fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return this.fallback();
    }
  }

  write(value: T): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export function newLocalId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
