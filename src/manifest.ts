import { log } from './log.js';
import * as safefs from './safefs.js';

export interface ManifestEntry {
  /**
   * Source file basename only (e.g. "cat.jpg"). The manifest does not
   * store the directory portion so it stays valid when `sourceDir` is
   * changed in config — entries are always interpreted relative to the
   * *current* `cfg.sourceDir`. Callers join with `cfg.sourceDir` to get
   * an absolute path for filesystem access.
   */
  sourceName: string;
  sourceMtime: number;
  sourceSize: number;
  contentHash: string;
  optimizedFilename: string;
  optimizedSize: number;
}

const MANIFEST_VERSION = 2;

interface SerializedManifest {
  version: typeof MANIFEST_VERSION;
  entries: ManifestEntry[];
}

// Older on-disk shape we still know how to migrate from.
interface LegacyEntryV1 {
  sourcePath: string;
  sourceMtime: number;
  sourceSize: number;
  contentHash: string;
  optimizedFilename: string;
  optimizedSize: number;
}

export class AssetManifest {
  private entries: ManifestEntry[] = [];
  private bySourceName = new Map<string, number>();
  private byContentHash = new Map<string, number>();
  private byOptimizedFilename = new Map<string, number>();

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
    const existing = this.bySourceName.get(entry.sourceName);
    if (existing !== undefined) {
      const old = this.entries[existing]!;
      this.byContentHash.delete(old.contentHash);
      this.byOptimizedFilename.delete(old.optimizedFilename);
      this.entries[existing] = entry;
      this.byContentHash.set(entry.contentHash, existing);
      this.byOptimizedFilename.set(entry.optimizedFilename, existing);
      this.bySourceName.set(entry.sourceName, existing);
    } else {
      const idx = this.entries.length;
      this.entries.push(entry);
      this.bySourceName.set(entry.sourceName, idx);
      this.byContentHash.set(entry.contentHash, idx);
      this.byOptimizedFilename.set(entry.optimizedFilename, idx);
    }
    this.schedulePersist();
  }

  removeBySourceName(sourceName: string): boolean {
    const idx = this.bySourceName.get(sourceName);
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

  getBySourceName(sourceName: string): ManifestEntry | undefined {
    const idx = this.bySourceName.get(sourceName);
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
    return { version: MANIFEST_VERSION, entries: [...this.entries] };
  }

  fromJSON(data: unknown): void {
    if (typeof data !== 'object' || data === null) {
      log.warn({ data }, 'Invalid manifest format, starting with empty manifest');
      return;
    }
    const obj = data as { version?: unknown; entries?: unknown };
    if (!Array.isArray(obj.entries)) {
      log.warn({ data }, 'Invalid manifest format, starting with empty manifest');
      return;
    }

    this.entries = [];
    this.bySourceName.clear();
    this.byContentHash.clear();
    this.byOptimizedFilename.clear();

    const isV1 = obj.version === 1;
    let migrated = 0;

    for (const raw of obj.entries) {
      let entry: ManifestEntry | null = null;
      if (isV1 && isLegacyV1Entry(raw)) {
        // Drop the directory part — the manifest is now sourceDir-relative.
        const legacy = raw as LegacyEntryV1;
        const sourceName = basenameOf(legacy.sourcePath);
        if (!sourceName) {
          log.warn({ entry: legacy }, 'Skipping legacy entry with empty source path');
          continue;
        }
        entry = {
          sourceName,
          sourceMtime: legacy.sourceMtime,
          sourceSize: legacy.sourceSize,
          contentHash: legacy.contentHash,
          optimizedFilename: legacy.optimizedFilename,
          optimizedSize: legacy.optimizedSize,
        };
        migrated++;
      } else if (isValidEntry(raw)) {
        entry = raw;
      } else {
        log.warn({ entry: raw }, 'Skipping invalid manifest entry');
        continue;
      }

      // If two legacy entries collapse onto the same basename (e.g. files
      // from two different absolute paths but same name), keep the first
      // and drop the rest — bootstrap will reconcile against the real
      // current sourceDir anyway.
      if (this.bySourceName.has(entry.sourceName)) {
        log.warn({ sourceName: entry.sourceName }, 'Duplicate sourceName during load, keeping first');
        continue;
      }

      const idx = this.entries.length;
      this.entries.push(entry);
      this.bySourceName.set(entry.sourceName, idx);
      this.byContentHash.set(entry.contentHash, idx);
      this.byOptimizedFilename.set(entry.optimizedFilename, idx);
    }

    if (migrated > 0) {
      log.info({ migrated }, 'Migrated manifest entries from v1 (sourcePath) to v2 (sourceName)');
      this.schedulePersist();
    }
  }

  /** Swap-with-last + pop for O(1) removal. */
  private _removeAtIndex(idx: number): void {
    const entry = this.entries[idx]!;
    this.bySourceName.delete(entry.sourceName);
    this.byContentHash.delete(entry.contentHash);
    this.byOptimizedFilename.delete(entry.optimizedFilename);

    const last = this.entries[this.entries.length - 1]!;
    if (idx !== this.entries.length - 1) {
      this.entries[idx] = last;
      this.bySourceName.set(last.sourceName, idx);
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
      safefs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2), 'utf8');
      safefs.renameSync(tmp, this.manifestPath);
      log.debug({ path: this.manifestPath, entries: this.entries.length }, 'Manifest persisted');
    } catch (err) {
      log.error({ err, path: this.manifestPath }, 'Failed to persist manifest');
      try { safefs.unlinkSync(tmp); } catch { /* ignore */ }
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
    typeof entry['sourceName'] === 'string' &&
    entry['sourceName'] !== '' &&
    typeof entry['sourceMtime'] === 'number' &&
    typeof entry['sourceSize'] === 'number' &&
    typeof entry['contentHash'] === 'string' &&
    typeof entry['optimizedFilename'] === 'string' &&
    typeof entry['optimizedSize'] === 'number'
  );
}

function isLegacyV1Entry(e: unknown): e is LegacyEntryV1 {
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

/** Cross-platform basename, accepting either '/' or '\' as separator. */
function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
