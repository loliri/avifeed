import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

export interface ManifestEntry {
  sourcePath: string;
  sourceMtime: number;
  sourceSize: number;
  contentHash: string;
  optimizedFilename: string;
  optimizedSize: number;
}

interface SerializedManifest {
  version: 1;
  entries: ManifestEntry[];
}

export class AssetManifest {
  private entries: ManifestEntry[] = [];
  private bySourcePath = new Map<string, number>(); // sourcePath -> index
  private byContentHash = new Map<string, number>(); // contentHash -> index
  private byOptimizedFilename = new Map<string, number>(); // optimizedFilename -> index

  private manifestPath: string;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_DEBOUNCE_MS = 200;

  constructor(manifestPath: string) {
    this.manifestPath = manifestPath;
  }

  get size(): number {
    return this.entries.length;
  }

  upsert(entry: ManifestEntry): void {
    const existing = this.bySourcePath.get(entry.sourcePath);
    if (existing !== undefined) {
      // Remove old indexes for the old entry
      const old = this.entries[existing]!;
      this.byContentHash.delete(old.contentHash);
      this.byOptimizedFilename.delete(old.optimizedFilename);
      // Replace in-place
      this.entries[existing] = entry;
      this.byContentHash.set(entry.contentHash, existing);
      this.byOptimizedFilename.set(entry.optimizedFilename, existing);
      this.bySourcePath.set(entry.sourcePath, existing);
    } else {
      const idx = this.entries.length;
      this.entries.push(entry);
      this.bySourcePath.set(entry.sourcePath, idx);
      this.byContentHash.set(entry.contentHash, idx);
      this.byOptimizedFilename.set(entry.optimizedFilename, idx);
    }
    this.schedulePersist();
  }

  removeBySourcePath(sourcePath: string): boolean {
    const idx = this.bySourcePath.get(sourcePath);
    if (idx === undefined) return false;
    this._removeAtIndex(idx);
    this.schedulePersist();
    return true;
  }

  removeByOptimizedFilename(filename: string): boolean {
    const idx = this.byOptimizedFilename.get(filename);
    if (idx === undefined) return false;
    this._removeAtIndex(idx);
    this.schedulePersist();
    return true;
  }

  getByOptimizedFilename(filename: string): ManifestEntry | undefined {
    const idx = this.byOptimizedFilename.get(filename);
    return idx !== undefined ? this.entries[idx] : undefined;
  }

  getBySourcePath(sourcePath: string): ManifestEntry | undefined {
    const idx = this.bySourcePath.get(sourcePath);
    return idx !== undefined ? this.entries[idx] : undefined;
  }

  /** Pick a random entry using the provided rng (default Math.random). */
  pickRandom(rng: () => number = Math.random): ManifestEntry | undefined {
    if (this.entries.length === 0) return undefined;
    const idx = Math.floor(rng() * this.entries.length);
    return this.entries[idx];
  }

  allEntries(): readonly ManifestEntry[] {
    return this.entries;
  }

  toJSON(): SerializedManifest {
    return { version: 1, entries: [...this.entries] };
  }

  fromJSON(data: unknown): void {
    if (
      typeof data !== 'object' ||
      data === null ||
      (data as SerializedManifest).version !== 1 ||
      !Array.isArray((data as SerializedManifest).entries)
    ) {
      log.warn({ data }, 'Invalid manifest format, starting with empty manifest');
      return;
    }
    const parsed = data as SerializedManifest;
    this.entries = [];
    this.bySourcePath.clear();
    this.byContentHash.clear();
    this.byOptimizedFilename.clear();
    for (const entry of parsed.entries) {
      if (!isValidEntry(entry)) {
        log.warn({ entry }, 'Skipping invalid manifest entry');
        continue;
      }
      const idx = this.entries.length;
      this.entries.push(entry);
      this.bySourcePath.set(entry.sourcePath, idx);
      this.byContentHash.set(entry.contentHash, idx);
      this.byOptimizedFilename.set(entry.optimizedFilename, idx);
    }
  }

  /** Swap-with-last + pop for O(1) removal. */
  private _removeAtIndex(idx: number): void {
    const entry = this.entries[idx]!;
    this.bySourcePath.delete(entry.sourcePath);
    this.byContentHash.delete(entry.contentHash);
    this.byOptimizedFilename.delete(entry.optimizedFilename);

    const last = this.entries[this.entries.length - 1]!;
    if (idx !== this.entries.length - 1) {
      this.entries[idx] = last;
      this.bySourcePath.set(last.sourcePath, idx);
      this.byContentHash.set(last.contentHash, idx);
      this.byOptimizedFilename.set(last.optimizedFilename, idx);
    }
    this.entries.pop();
  }

  private schedulePersist(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.persistSync();
    }, this.FLUSH_DEBOUNCE_MS);
  }

  /** Atomic write: write to .tmp then rename. */
  persistSync(): void {
    const tmp = this.manifestPath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2), 'utf8');
      fs.renameSync(tmp, this.manifestPath);
      log.debug({ path: this.manifestPath, entries: this.entries.length }, 'Manifest persisted');
    } catch (err) {
      log.error({ err, path: this.manifestPath }, 'Failed to persist manifest');
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  /** Cancel pending flush and do a synchronous flush immediately. */
  flushNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.persistSync();
  }
}

function isValidEntry(e: unknown): e is ManifestEntry {
  if (typeof e !== 'object' || e === null) return false;
  const entry = e as Record<string, unknown>;
  return (
    typeof entry['sourcePath'] === 'string' &&
    typeof entry['sourceMtime'] === 'number' &&
    typeof entry['sourceSize'] === 'number' &&
    typeof entry['contentHash'] === 'string' &&
    typeof entry['optimizedFilename'] === 'string' &&
    typeof entry['optimizedSize'] === 'number'
  );
}
