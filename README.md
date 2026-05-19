# avifeed

📖 README: **English** | **[简体中文](README.zh.md)**

**avifeed** turns a folder of images into a low-bandwidth random-image endpoint. Drop originals in; the server transcodes them to AVIF in the background, keeps itself in sync as files come and go, and serves a different one on every `GET /` — at a fraction of the bytes.

What makes it different from a one-line "pick a random file" script:

- **Automatic AVIF compression.** Every image is re-encoded with sharp + libvips, typically **70–80 % smaller** than the original JPEG/PNG, with no visible quality loss. You upload originals; visitors get AVIF.
- **Self-syncing.** A file watcher tracks adds, edits, and deletions in the source folder in real time. Re-encoding is debounced against half-written uploads, deduped against in-flight jobs, and persisted atomically — so the manifest and disk never disagree even after a crash.
- **Source files are protected by design.** `sourceDir` is treated as strictly read-only. Every filesystem write in the codebase goes through a guard (`src/safefs.ts`) that hard-fails any write outside the registered output roots. Your originals cannot be touched, even by a buggy future change.
- **Cache-friendly delivery.** Output filenames embed a content hash, so `/images/<name>.<hash>.avif` can be served with a 1-year `immutable` cache. `GET /` returns a fresh random pick on every call; `GET /?redirect=1` issues a 302 to the stable URL so browsers can cache the bytes.

---

## Features

- Drop images into a folder → they are encoded to AVIF automatically
- Content-addressed output filenames (`name.<sha256prefix>.avif`) — safe to cache forever
- `GET /` returns a random image on every call
- `GET /?redirect=1` issues a 302 to the stable content URL so browsers can cache it
- ETag + `Cache-Control: immutable` on `/images/:filename`
- File watcher (chokidar) picks up additions, changes, and deletions in real time
- Manifest persisted to disk atomically — survives restarts without re-encoding
- Source directory is read-only at runtime, enforced by a write-path guard
- `/healthz`, `/readyz`, `/metrics` endpoints out of the box
- Graceful shutdown: drains the encode queue before exiting (with a 10 s hard timeout)
- Configurable via `config.json` and `RIS_*` environment variables

---

## Requirements

- Node.js ≥ 20
- `npm install` (sharp bundles its own libvips — no system dependency needed on most platforms)

---

## Quick start

```sh
git clone https://github.com/<you>/avifeed.git
cd avifeed
npm install
cp config.example.json config.json   # edit as needed
npm run build
npm start
```

Drop images into `./images/source/`. Visit `http://localhost:2333/` to get a random one.

---

## HTTP API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Returns a random AVIF image (`Cache-Control: no-store`) |
| `GET` | `/?redirect=1` | 302 redirect to the content-addressed URL |
| `GET` | `/images/:filename` | Serves a specific image; ETag + 1-year immutable cache |
| `GET` | `/healthz` | Liveness probe — always `{"status":"ok"}` |
| `GET` | `/readyz` | Readiness probe — checks the output dir is writable, returns manifest size |
| `GET` | `/metrics` | Plain-text metrics: manifest entries, optimizer queue length |

---

## Configuration

Copy `config.example.json` to `config.json` and edit. Every field also has an `RIS_*` environment variable that takes precedence.

| Field | Env var | Default | Description |
| --- | --- | --- | --- |
| `port` | `RIS_PORT` | `2333` | HTTP port |
| `sourceDir` | `RIS_SOURCE_DIR` | `./images/source` | Source images directory |
| `optimizedDir` | `RIS_OPTIMIZED_DIR` | `./images/optimized` | AVIF output directory |
| `manifestPath` | `RIS_MANIFEST_PATH` | `./images/manifest.json` | Manifest file path |
| `avifQuality` | `RIS_AVIF_QUALITY` | `50` | AVIF quality 1–100 |
| `avifEffort` | `RIS_AVIF_EFFORT` | `4` | AVIF encode effort 0–9 (higher = smaller file, slower) |
| `watch` | `RIS_WATCH` | `true` | Watch source dir for changes |
| `scanOnStart` | `RIS_SCAN_ON_START` | `false` | Re-scan source dir on every startup |
| `asyncIo` | `RIS_ASYNC_IO` | `false` | Use `fs.promises` in the optimizer (sync by default to throttle disk pressure) |
| `stabilizeMs` | `RIS_STABILIZE_MS` | `200` | How long file size must stay constant before encoding starts |
| `stabilizePollMs` | `RIS_STABILIZE_POLL_MS` | `50` | Poll interval for stabilization check |
| `stabilizeTimeoutMs` | `RIS_STABILIZE_TIMEOUT_MS` | `10000` | Max wait for stabilization |
| _(env only)_ | `RIS_HASH_LENGTH` | `8` | Hex chars of SHA-256 to embed in filename |
| _(env only)_ | `RIS_LOG_LEVEL` | `info` | pino log level |
| _(env only)_ | `RIS_CONFIG` | `./config.json` | Path to config file |

### `scanOnStart` in detail

This flag controls **whether `sourceDir` is scanned at startup**. It does *not* affect the manifest reconciliation against `optimizedDir`, which always runs.

On every startup, regardless of `scanOnStart`:

- The manifest is loaded from disk.
- `optimizedDir` is reconciled with the manifest in both directions:
  - manifest entry whose AVIF file is missing → entry is dropped;
  - AVIF file on disk that has no manifest entry → file is deleted.
- `sourceDir` is **not** read or stat'd — it is left completely untouched. (Useful if `sourceDir` lives on a slow / removable / network volume that may not be ready at boot.)

When `scanOnStart=true`, additionally:

- `sourceDir` is listed and each image file is `stat`'d.
- Any file that is new, or whose size/mtime differs from the manifest, is enqueued for encoding.

When `scanOnStart=false` (default):

- `sourceDir` is never touched at startup. The watcher is solely responsible for picking up changes once the server is running. Files added while the server was down will not be processed until they are touched again.

---

## Deployment

A hardened systemd unit is in [`deploy/avifeed.service`](deploy/avifeed.service). See [`deploy/README.md`](deploy/README.md) for installation steps.

Run behind a reverse proxy (nginx, caddy) for TLS and rate limiting.

---

## How it works

1. **Bootstrap** — loads the manifest, then reconciles `optimizedDir` against it: drops manifest entries whose AVIF is gone, deletes AVIF files that the manifest doesn't know about. If `scanOnStart=true`, additionally scans `sourceDir` for new or changed files and enqueues them.
2. **Watch** — chokidar monitors the source directory (non-recursive). Only recognised image extensions are processed; hidden files and temp files are ignored.
3. **Stabilize** — before encoding, the optimizer polls the file size until it stays constant for `stabilizeMs` ms, avoiding reads on half-written uploads.
4. **Encode** — sharp converts the source to AVIF and writes it atomically (temp file → rename). If the same source file changes again while encoding, the in-flight job is aborted and a new one is queued.
5. **Persist** — the manifest is written synchronously via tmp-file + rename after every change, so a crash leaves no inconsistency.

---

## Source directory is read-only

avifeed treats `sourceDir` as a strictly **read-only** input. The server only `stat`s, reads, and watches files there — it never creates, renames, deletes, or modifies source files. All writes go to `optimizedDir` and `manifestPath`.

This is enforced at runtime, not just by convention. Every filesystem write in the codebase goes through a small wrapper (`src/safefs.ts`) that resolves the target path and rejects it with `EWRITEFORBIDDEN` unless it sits under one of the writable roots registered at startup (`optimizedDir` and the directory containing `manifestPath`). A future code change that accidentally tries to write inside `sourceDir` will throw immediately rather than silently mutate your originals.

---

## Why AVIF?

AVIF (AV1 Image File Format) is the most efficient widely-supported image format today:

- **30–50 % smaller** than JPEG at equivalent visual quality
- **Better than WebP** on complex gradients and fine detail
- **HDR and wide-gamut** support built in
- Supported natively in Chrome, Firefox, Safari 16+, and all modern mobile browsers

Serving AVIF means less bandwidth, faster page loads, and lower storage costs — with no visible quality loss.

---

## Project layout

```
src/
  index.ts        entrypoint — wires everything together
  config.ts       config loading and validation
  log.ts          pino logger
  manifest.ts     source-to-optimized mapping, atomic persistence
  hash.ts         SHA-256 content hash
  watcher.ts      chokidar wrapper with extension filtering
  optimizer.ts    serial encode queue with abort support
  bootstrap.ts    startup reconciliation
  server.ts       fastify routes
  safefs.ts       write-path guard — refuses writes outside writable roots
deploy/
  avifeed.service systemd unit
  README.md       deployment guide
config.example.json
```

---

## License

ISC
