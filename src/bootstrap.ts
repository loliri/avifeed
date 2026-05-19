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
  // Step 1: Load manifest from disk
  try {
    const raw = fs.readFileSync(cfg.manifestPath, 'utf8');
    manifest.fromJSON(JSON.parse(raw));
    log.info({ path: cfg.manifestPath, entries: manifest.size }, 'Loaded manifest');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err }, 'Failed to read manifest, starting fresh');
    }
  }

  // Step 2: Remove stale entries
  // 2a. Optimized file missing → orphan
  // 2b. Source file missing → remove from manifest (source was deleted)
  for (const entry of [...manifest.allEntries()]) {
    const optimizedPath = path.join(cfg.optimizedDir, entry.optimizedFilename);
    if (!fs.existsSync(optimizedPath)) {
      log.info({ entry: entry.optimizedFilename }, 'Removing orphan manifest entry (optimized file missing)');
      manifest.removeByOptimizedFilename(entry.optimizedFilename);
      continue;
    }
    if (!fs.existsSync(entry.sourcePath)) {
      log.info({ sourcePath: entry.sourcePath }, 'Removing manifest entry (source file deleted)');
      manifest.removeBySourcePath(entry.sourcePath);
      // Also delete the optimized file
      try {
        safefs.unlinkSync(path.join(cfg.optimizedDir, entry.optimizedFilename));
        log.info({ file: entry.optimizedFilename }, 'Deleted optimized file for removed source');
      } catch { /* already gone */ }
    }
  }

  // Step 3: Scan source directory for new/changed files (skipped if scanOnStart is false)
  if (cfg.scanOnStart) {
    let sourceFiles: string[];
    try {
      sourceFiles = fs.readdirSync(cfg.sourceDir);
    } catch (err) {
      log.warn({ err }, 'Failed to read source directory during bootstrap');
      sourceFiles = [];
    }

    for (const filename of sourceFiles) {
      if (!shouldHandle(filename)) continue;
      const sourcePath = path.join(cfg.sourceDir, filename);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(sourcePath);
      } catch {
        continue;
      }

      const existing = manifest.getBySourcePath(sourcePath);
      if (
        !existing ||
        existing.sourceMtime !== stat.mtimeMs ||
        existing.sourceSize !== stat.size
      ) {
        log.debug({ sourcePath }, 'Bootstrap: enqueuing for optimization');
        optimizer.enqueue(sourcePath);
      }
    }
  } else {
    log.info('Skipping source dir scan on startup (scanOnStart=false)');
  }

  // Persist updated manifest after cleanup
  manifest.flushNow();
}
