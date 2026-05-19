import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { contentHash } from './hash.js';
import { AssetManifest } from './manifest.js';
import { log } from './log.js';
import * as safefs from './safefs.js';
import type { ServerConfig } from './config.js';

interface PendingJob {
  sourcePath: string;
  controller: AbortController;
}

export class ImageOptimizer {
  // Serial queue: one disk read at a time
  private queue: PendingJob[] = [];
  private running = false;
  private currentJob: PendingJob | null = null;
  private cfg: ServerConfig;
  private manifest: AssetManifest;

  constructor(cfg: ServerConfig, manifest: AssetManifest) {
    this.cfg = cfg;
    this.manifest = manifest;
  }

  enqueue(sourcePath: string): void {
    // Cancel a currently-running job for the same path so we don't
    // waste CPU finishing an encode whose source has already changed.
    if (this.currentJob && this.currentJob.sourcePath === sourcePath) {
      this.currentJob.controller.abort();
    }
    // Drop any pending duplicates for this path.
    this.queue = this.queue.filter((j) => j.sourcePath !== sourcePath);

    const controller = new AbortController();
    this.queue.push({ sourcePath, controller });
    this._pump();
  }

  private _pump(): void {
    if (this.running || this.queue.length === 0) return;
    this.running = true;

    const job = this.queue.shift()!;
    this.currentJob = job;
    if (job.controller.signal.aborted) {
      this.currentJob = null;
      this.running = false;
      this._pump();
      return;
    }

    this._run(job.sourcePath, job.controller.signal).finally(() => {
      this.currentJob = null;
      this.running = false;
      this._pump();
    });
  }

  async runOnce(
    bytes: Buffer,
    sourcePath: string,
    signal?: AbortSignal,
  ): Promise<{ contentHash: string; optimizedFilename: string } | null> {
    const hash = contentHash(bytes, this.cfg.hashLength);
    if (signal?.aborted) return null;

    const basename = path.basename(sourcePath, path.extname(sourcePath));
    const optimizedFilename = `${basename}.${hash}.avif`;
    const optimizedPath = path.join(this.cfg.optimizedDir, optimizedFilename);

    const existing = this.manifest.getBySourcePath(sourcePath);
    if (existing && existing.contentHash === hash) {
      log.debug({ sourcePath, hash }, 'Skipping: content unchanged');
      return { contentHash: hash, optimizedFilename: existing.optimizedFilename };
    }

    if (signal?.aborted) return null;

    let avifBytes: Buffer;
    try {
      avifBytes = await sharp(bytes)
        .avif({ quality: this.cfg.avifQuality, effort: this.cfg.avifEffort })
        .toBuffer();
    } catch (err) {
      log.warn({ err, sourcePath }, 'Failed to encode image, skipping');
      return null;
    }

    if (signal?.aborted) return null;

    const tmp = optimizedPath + `.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      if (this.cfg.asyncIo) {
        await safefs.writeFile(tmp, avifBytes);
        if (signal?.aborted) { await safefs.unlink(tmp).catch(() => {}); return null; }
        await safefs.rename(tmp, optimizedPath);
      } else {
        safefs.writeFileSync(tmp, avifBytes);
        if (signal?.aborted) { safefs.unlinkSync(tmp); return null; }
        safefs.renameSync(tmp, optimizedPath);
      }
    } catch (err) {
      log.error({ err, sourcePath, tmp }, 'Failed to write optimized file');
      if (this.cfg.asyncIo) {
        await safefs.unlink(tmp).catch(() => {});
      } else {
        try { safefs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      return null;
    }

    let sourceMtime = 0, sourceSize = bytes.length;
    try {
      const stat = this.cfg.asyncIo
        ? await fsp.stat(sourcePath)
        : fs.statSync(sourcePath);
      sourceMtime = stat.mtimeMs;
      sourceSize = stat.size;
    } catch { /* use defaults */ }

    // If a previous optimized file existed for the same source, remove it
    const prev = this.manifest.getBySourcePath(sourcePath);
    if (prev && prev.optimizedFilename !== optimizedFilename) {
      const stalePath = path.join(this.cfg.optimizedDir, prev.optimizedFilename);
      if (this.cfg.asyncIo) {
        await safefs.unlink(stalePath).catch(() => {});
      } else {
        try { safefs.unlinkSync(stalePath); } catch { /* already gone */ }
      }
      log.info({ file: prev.optimizedFilename }, 'Removed stale optimized file for re-encoded source');
    }

    this.manifest.upsert({
      sourcePath, sourceMtime, sourceSize,
      contentHash: hash, optimizedFilename, optimizedSize: avifBytes.length,
    });
    // Persist immediately: a crash between upsert and the debounced flush
    // would leave manifest and disk inconsistent until the next bootstrap.
    this.manifest.flushNow();

    log.info({ sourcePath, optimizedFilename, hash }, 'Optimized image');
    return { contentHash: hash, optimizedFilename };
  }

  private async _run(sourcePath: string, signal: AbortSignal): Promise<void> {
    const { stabilizeMs, stabilizePollMs, stabilizeTimeoutMs } = this.cfg;
    const deadline = Date.now() + stabilizeTimeoutMs;
    let prevSize = -1, stableAt = -1;

    while (Date.now() < deadline) {
      if (signal.aborted) return;
      let size = -1;
      try {
        if (this.cfg.asyncIo) {
          size = (await fsp.stat(sourcePath)).size;
        } else {
          size = fs.statSync(sourcePath).size;
        }
      } catch { return; }

      if (size === prevSize) {
        if (stableAt < 0) stableAt = Date.now();
        if (Date.now() - stableAt >= stabilizeMs) break;
      } else {
        prevSize = size;
        stableAt = -1;
      }
      await new Promise<void>((r) => setTimeout(r, stabilizePollMs));
    }

    if (signal.aborted) return;

    let bytes: Buffer;
    try {
      bytes = this.cfg.asyncIo
        ? await fsp.readFile(sourcePath)
        : fs.readFileSync(sourcePath);
    } catch (err) {
      log.error({ err, sourcePath }, 'Failed to read source file');
      return;
    }

    await this.runOnce(bytes, sourcePath, signal);
  }

  async drain(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }

  stats(): { queueLength: number; running: boolean } {
    return { queueLength: this.queue.length, running: this.running };
  }
}
