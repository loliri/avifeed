import path from 'node:path';
import { loadConfig } from './config.js';
import { AssetManifest } from './manifest.js';
import { ImageOptimizer } from './optimizer.js';
import { FileWatcher } from './watcher.js';
import { bootstrap } from './bootstrap.js';
import { buildServer } from './server.js';
import { log } from './log.js';
import * as safefs from './safefs.js';

async function main() {
  const cfg = loadConfig();

  // Register writable roots BEFORE any module performs filesystem writes.
  // This enforces the invariant that the source directory is read-only.
  safefs.initSafeFs([cfg.optimizedDir, path.dirname(cfg.manifestPath)]);

  const manifest = new AssetManifest(cfg.manifestPath);
  const optimizer = new ImageOptimizer(cfg, manifest);
  const watcher = new FileWatcher(cfg);

  // Bootstrap: load manifest, clean orphans, scan source dir
  await bootstrap(cfg, manifest, optimizer);

  // Wire watcher events to optimizer
  watcher.on('job', (sourceName: string) => optimizer.enqueue(sourceName));
  watcher.on('remove', (sourceName: string) => {
    const entry = manifest.getBySourceName(sourceName);
    if (entry) {
      const optimizedPath = path.join(cfg.optimizedDir, entry.optimizedFilename);
      try { safefs.unlinkSync(optimizedPath); } catch { /* already gone */ }
      log.info({ file: entry.optimizedFilename }, 'Deleted optimized file for removed source');
    }
    manifest.removeBySourceName(sourceName);
    manifest.flushNow();
  });

  // Start watcher after bootstrap (only if watch mode enabled)
  if (cfg.watch) {
    watcher.start();
    log.info('File watcher started');
  } else {
    log.info('Watch mode disabled — processing source dir on startup only');
  }

  // Build and start HTTP server
  const app = buildServer(cfg, manifest, optimizer);
  try {
    await app.listen({ port: cfg.port, host: '0.0.0.0' });
    log.info({ port: cfg.port }, 'Server started');
  } catch (err) {
    log.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutting down...');

    // Hard-kill after 10 s so a stuck drain/close never blocks exit.
    const forceExit = setTimeout(() => {
      log.warn('Shutdown timed out after 10 s, forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref(); // don't let this timer itself keep the process alive

    await watcher.stop();
    await optimizer.drain();
    manifest.flushNow();
    await app.close();
    clearTimeout(forceExit);
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaughtException, shutting down');
    void shutdown('uncaughtException').catch(() => process.exit(1));
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
