import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';
import { AssetManifest } from './manifest.js';
import { ImageOptimizer } from './optimizer.js';
import type { ServerConfig } from './config.js';

export function buildServer(
  cfg: ServerConfig,
  manifest: AssetManifest,
  optimizer?: ImageOptimizer,
) {
  const app = Fastify({ logger: false });

  app.addHook('onResponse', async (request, reply) => {
    log.info({
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    }, 'request');
  });

  // GET / — return a random image
  app.get('/', async (request, reply) => {
    const entry = manifest.pickRandom();
    if (!entry) {
      return reply.status(503).send({ error: 'no_images', message: 'No images available' });
    }

    const redirect = (request.query as Record<string, string>)['redirect'];
    if (redirect === '1') {
      return reply
        .status(302)
        .header('Location', `/images/${entry.optimizedFilename}`)
        .header('Cache-Control', 'no-store')
        .send();
    }

    const filePath = path.join(cfg.optimizedDir, entry.optimizedFilename);
    if (!fs.existsSync(filePath)) {
      log.error({ filePath }, 'Optimized file referenced by manifest is missing');
      return reply.status(500).send({ error: 'read_error', message: 'Failed to read image' });
    }

    return reply
      .status(200)
      .header('Content-Type', 'image/avif')
      .header('Cache-Control', 'no-store')
      .send(fs.createReadStream(filePath));
  });

  // GET /images/:filename — serve a specific optimized image
  app.get('/images/:filename', async (request, reply) => {
    const { filename } = request.params as { filename: string };
    // Defense in depth: even though manifest lookup acts as a whitelist,
    // explicitly reject anything that isn't a plain basename.
    if (
      !filename ||
      filename !== path.basename(filename) ||
      filename.includes('\0') ||
      filename === '.' ||
      filename === '..'
    ) {
      return reply.status(400).send({ error: 'bad_request', message: 'Invalid filename' });
    }
    const entry = manifest.getByOptimizedFilename(filename);
    if (!entry) {
      return reply.status(404).send({ error: 'not_found', message: 'Image not found' });
    }

    const etag = `"${entry.contentHash}"`;
    const ifNoneMatch = (request.headers as Record<string, string>)['if-none-match'];
    if (ifNoneMatch === etag) {
      return reply.status(304).send();
    }

    const filePath = path.join(cfg.optimizedDir, filename);
    if (!fs.existsSync(filePath)) {
      log.error({ filePath }, 'Optimized file referenced by manifest is missing');
      return reply.status(500).send({ error: 'read_error', message: 'Failed to read image' });
    }

    return reply
      .status(200)
      .header('Content-Type', 'image/avif')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('ETag', etag)
      .send(fs.createReadStream(filePath));
  });

  // GET /healthz — liveness
  app.get('/healthz', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  // GET /readyz — readiness (manifest loaded, optimized dir writable)
  app.get('/readyz', async (_request, reply) => {
    try {
      fs.accessSync(cfg.optimizedDir, fs.constants.W_OK);
    } catch {
      return reply.status(503).send({ status: 'not_ready', reason: 'optimizedDir not writable' });
    }
    return reply.status(200).send({
      status: 'ready',
      manifestEntries: manifest.size,
    });
  });

  // GET /metrics — minimal text metrics (Prometheus-friendly key=value lines)
  app.get('/metrics', async (_request, reply) => {
    const stats = optimizer?.stats() ?? { queueLength: 0, running: false };
    const body =
      `manifest_entries ${manifest.size}\n` +
      `optimizer_queue_length ${stats.queueLength}\n` +
      `optimizer_running ${stats.running ? 1 : 0}\n`;
    return reply
      .status(200)
      .header('Content-Type', 'text/plain; version=0.0.4')
      .send(body);
  });

  // Global error handler
  app.setErrorHandler((err, _request, reply) => {
    log.error({ err }, 'Unhandled request error');
    reply.status(500).send({ error: 'internal_error', message: 'Internal server error' });
  });

  return app;
}
