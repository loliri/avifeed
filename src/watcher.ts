import chokidar from 'chokidar';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { log } from './log.js';
import type { ServerConfig } from './config.js';

// Image extensions sharp can decode. Anything else is ignored.
const SUPPORTED_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff',
  '.avif', '.heic', '.heif', '.svg',
]);

export function shouldHandle(filename: string): boolean {
  const base = path.basename(filename);
  // Reject hidden / temp files (.DS_Store, .crdownload, partial uploads, etc.)
  if (base.startsWith('.')) return false;
  if (base.endsWith('.tmp') || base.endsWith('.crdownload') || base.endsWith('.part')) return false;
  const ext = path.extname(base).toLowerCase();
  return SUPPORTED_EXTS.has(ext);
}

export interface WatcherEvents {
  // sourceName is the basename of the file inside cfg.sourceDir.
  // The directory is implicit (always cfg.sourceDir at the time of the event).
  job: [sourceName: string];
  remove: [sourceName: string];
}

export class FileWatcher extends EventEmitter<WatcherEvents> {
  private watcher: ReturnType<typeof chokidar.watch> | null = null;
  private cfg: ServerConfig;

  constructor(cfg: ServerConfig) {
    super();
    this.cfg = cfg;
  }

  start(): void {
    this.watcher = chokidar.watch(this.cfg.sourceDir, {
      ignoreInitial: true,
      depth: 0,
    });

    this.watcher.on('add', (filePath: string) => {
      if (shouldHandle(filePath)) {
        const sourceName = path.basename(filePath);
        log.debug({ sourceName }, 'Watcher: add');
        this.emit('job', sourceName);
      }
    });

    this.watcher.on('change', (filePath: string) => {
      if (shouldHandle(filePath)) {
        const sourceName = path.basename(filePath);
        log.debug({ sourceName }, 'Watcher: change');
        this.emit('job', sourceName);
      }
    });

    this.watcher.on('unlink', (filePath: string) => {
      if (shouldHandle(filePath)) {
        const sourceName = path.basename(filePath);
        log.debug({ sourceName }, 'Watcher: unlink');
        this.emit('remove', sourceName);
      }
    });

    this.watcher.on('error', (err: unknown) => {
      log.error({ err }, 'Watcher error (continuing)');
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
