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

  // Step 2: Clean up optimizedDir — always runs regardless of scanOnStart.
  // sourceDir is never touched here; only optimizedDir is inspected/modified.

  // 2a. Manifest entry whose avif file is gone → remove the entry
  for (const entry of [...manifest.allEntries()]) {
    const optimizedPath = path.join(cfg.optimizedDir, entry.optimizedFilename);
    if (!fs.existsSync(optimizedPath)) {
      log.info({ file: entry.optimizedFilename }, 'Removing orphan manifest entry (optimized file missing)');
      manifest.removeByOptimizedFilename(entry.optimizedFilename);
    }
  }

  // 2b. avif file on disk that has no manifest entry → delete the file
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
