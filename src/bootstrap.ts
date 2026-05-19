import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';
import { AssetManifest } from './manifest.js';
import { ImageOptimizer } from './optimizer.js';
import { shouldHandle } from './watcher.js';
import * as safefs from './safefs.js';
import type { ServerConfig } from './config.js';

export async function bootstrap(
  cfg: ServerConfig,
  manifest: AssetManifest,
  optimizer: ImageOptimizer,
): Promise<void> {
  // Step 1: Load manifest from disk (handles v1 → v2 migration internally).
  try {
    const raw = fs.readFileSync(cfg.manifestPath, 'utf8');
    manifest.fromJSON(JSON.parse(raw));
    log.info({ path: cfg.manifestPath, entries: manifest.size }, 'Loaded manifest');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err }, 'Failed to read manifest, starting fresh');
    }
  }

  // Step 2: Reconcile against the *current* sourceDir.
  //
  // The manifest is sourceDir-relative (entries keyed by basename). The
  // current sourceDir is the only authority on what should exist — files
  // that aren't there now must be evicted, even if their optimized .avif
  // happens to still be on disk. This prevents pollution when sourceDir
  // is repointed at a different folder.
  let sourceFilesArr: string[] | null;
  try {
    sourceFilesArr = fs.readdirSync(cfg.sourceDir);
  } catch (err) {
    log.warn({ err, sourceDir: cfg.sourceDir }, 'Failed to read source directory during bootstrap');
    sourceFilesArr = null;
  }

  if (sourceFilesArr !== null) {
    const presentSources = new Set(sourceFilesArr.filter(shouldHandle));

    // 2a. Drop manifest entries whose source isn't in the current sourceDir,
    //     and delete the corresponding optimized file.
    for (const entry of [...manifest.allEntries()]) {
      if (!presentSources.has(entry.sourceName)) {
        const stalePath = path.join(cfg.optimizedDir, entry.optimizedFilename);
        try {
          safefs.unlinkSync(stalePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn({ err, file: entry.optimizedFilename }, 'Failed to delete stale optimized file');
          }
        }
        manifest.removeBySourceName(entry.sourceName);
        log.info({
          sourceName: entry.sourceName,
          optimizedFilename: entry.optimizedFilename,
        }, 'Evicted entry: source not in current sourceDir');
      }
    }
  } else {
    // We couldn't list sourceDir at all — fall back to the previous, more
    // forgiving rule: only drop entries whose optimized file is missing.
    for (const entry of [...manifest.allEntries()]) {
      const optimizedPath = path.join(cfg.optimizedDir, entry.optimizedFilename);
      if (!fs.existsSync(optimizedPath)) {
        log.info({ file: entry.optimizedFilename }, 'Removing orphan manifest entry (optimized file missing)');
        manifest.removeByOptimizedFilename(entry.optimizedFilename);
      }
    }
  }

  // 2b. Also drop manifest entries whose optimized file is gone on disk
  //     (e.g. someone deleted from optimizedDir manually).
  for (const entry of [...manifest.allEntries()]) {
    const optimizedPath = path.join(cfg.optimizedDir, entry.optimizedFilename);
    if (!fs.existsSync(optimizedPath)) {
      log.info({ file: entry.optimizedFilename }, 'Removing orphan manifest entry (optimized file missing)');
      manifest.removeByOptimizedFilename(entry.optimizedFilename);
    }
  }

  // 2c. avif file on disk that has no manifest entry → delete the file.
  let optimizedFiles: string[];
  try {
    optimizedFiles = fs.readdirSync(cfg.optimizedDir);
  } catch (err) {
    log.warn({ err }, 'Failed to read optimized directory during bootstrap');
    optimizedFiles = [];
  }
  for (const filename of optimizedFiles) {
    if (!filename.endsWith('.avif')) continue;
    if (!manifest.getByOptimizedFilename(filename)) {
      const stalePath = path.join(cfg.optimizedDir, filename);
      try {
        safefs.unlinkSync(stalePath);
        log.info({ file: filename }, 'Deleted untracked avif file (not in manifest)');
      } catch { /* already gone */ }
    }
  }

  // Step 3: Scan sourceDir for new/changed files — only when scanOnStart=true.
  // With scanOnStart=false the server trusts the manifest as-is and relies
  // on the watcher to pick up changes at runtime.
  if (cfg.scanOnStart) {
    const sourceFiles = sourceFilesArr ?? [];
    for (const filename of sourceFiles) {
      if (!shouldHandle(filename)) continue;
      const sourcePath = path.join(cfg.sourceDir, filename);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(sourcePath);
      } catch {
        continue;
      }

      const existing = manifest.getBySourceName(filename);
      if (
        !existing ||
        existing.sourceMtime !== stat.mtimeMs ||
        existing.sourceSize !== stat.size
      ) {
        log.debug({ sourceName: filename }, 'Bootstrap: enqueuing for optimization');
        optimizer.enqueue(filename);
      }
    }
  } else {
    log.info('Skipping source dir scan on startup (scanOnStart=false)');
  }

  // Persist updated manifest after cleanup
  manifest.flushNow();
}
