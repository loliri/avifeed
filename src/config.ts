import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

export interface ServerConfig {
  port: number;
  sourceDir: string;
  optimizedDir: string;
  manifestPath: string;
  hashLength: number;
  avifQuality: number;
  avifEffort: number;
  fairnessMultiplier: number;
  watch: boolean;
  scanOnStart: boolean;
  asyncIo: boolean;
  stabilizeMs: number;
  stabilizePollMs: number;
  stabilizeTimeoutMs: number;
}

// Partial config file schema — only the user-facing fields
interface ConfigFile {
  port?: number;
  sourceDir?: string;
  optimizedDir?: string;
  manifestPath?: string;
  avifQuality?: number;
  avifEffort?: number;
  watch?: boolean;
  scanOnStart?: boolean;
  asyncIo?: boolean;
  stabilizeMs?: number;
  stabilizePollMs?: number;
  stabilizeTimeoutMs?: number;
}

const CONFIG_FILE = path.resolve(process.env['RIS_CONFIG'] ?? './config.json');

function readConfigFile(): ConfigFile {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw) as ConfigFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, path: CONFIG_FILE }, 'Failed to read config file, using defaults');
    }
    return {};
  }
}

function parseIntEnv(
  name: string,
  raw: string | undefined,
  defaultVal: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return defaultVal;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    log.fatal(
      { field: name, value: raw, min, max },
      `Invalid config: ${name}=${raw} must be an integer in [${min}, ${max}]`,
    );
    process.exit(1);
  }
  return n;
}

function clamp(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    log.fatal(
      { field: name, value, min, max },
      `Invalid config.json: ${name}=${value} must be an integer in [${min}, ${max}]`,
    );
    process.exit(1);
  }
  return value;
}

export function loadConfig(): ServerConfig {
  const file = readConfigFile();

  // Priority: env var > config.json > hardcoded default
  const port = parseIntEnv('RIS_PORT', process.env['RIS_PORT'],
    file.port !== undefined ? clamp('port', file.port, 1, 65535) : 2333, 1, 65535);

  const avifQuality = parseIntEnv('RIS_AVIF_QUALITY', process.env['RIS_AVIF_QUALITY'],
    file.avifQuality !== undefined ? clamp('avifQuality', file.avifQuality, 1, 100) : 50, 1, 100);

  const avifEffort = parseIntEnv('RIS_AVIF_EFFORT', process.env['RIS_AVIF_EFFORT'],
    file.avifEffort !== undefined ? clamp('avifEffort', file.avifEffort, 0, 9) : 4, 0, 9);

  const hashLength = parseIntEnv('RIS_HASH_LENGTH', process.env['RIS_HASH_LENGTH'], 8, 4, 64);

  const fairnessMultiplier = parseIntEnv(
    'RIS_FAIRNESS_MULTIPLIER', process.env['RIS_FAIRNESS_MULTIPLIER'], 10, 1, 1000);

  // watch: env var "0"/"false" → off, config.json watch:false → off, default on
  const watchEnv = process.env['RIS_WATCH'];
  const watch = watchEnv !== undefined
    ? watchEnv !== '0' && watchEnv.toLowerCase() !== 'false'
    : (file.watch ?? true);

  const scanOnStartEnv = process.env['RIS_SCAN_ON_START'];
  const scanOnStart = scanOnStartEnv !== undefined
    ? scanOnStartEnv !== '0' && scanOnStartEnv.toLowerCase() !== 'false'
    : (file.scanOnStart ?? false);

  // asyncIo: default false (synchronous IO). Set to true to switch the
  // optimizer's read/write/stat calls to fs.promises. Off by default
  // because synchronous IO naturally throttles disk pressure.
  const asyncIoEnv = process.env['RIS_ASYNC_IO'];
  const asyncIo = asyncIoEnv !== undefined
    ? asyncIoEnv !== '0' && asyncIoEnv.toLowerCase() !== 'false'
    : (file.asyncIo ?? false);

  const stabilizeMs = parseIntEnv(
    'RIS_STABILIZE_MS', process.env['RIS_STABILIZE_MS'],
    file.stabilizeMs !== undefined ? clamp('stabilizeMs', file.stabilizeMs, 0, 60000) : 200, 0, 60000);

  const stabilizePollMs = parseIntEnv(
    'RIS_STABILIZE_POLL_MS', process.env['RIS_STABILIZE_POLL_MS'],
    file.stabilizePollMs !== undefined ? clamp('stabilizePollMs', file.stabilizePollMs, 10, 5000) : 50, 10, 5000);

  const stabilizeTimeoutMs = parseIntEnv(
    'RIS_STABILIZE_TIMEOUT_MS', process.env['RIS_STABILIZE_TIMEOUT_MS'],
    file.stabilizeTimeoutMs !== undefined ? clamp('stabilizeTimeoutMs', file.stabilizeTimeoutMs, 1000, 300000) : 10000, 1000, 300000);

  const sourceDir = path.resolve(
    process.env['RIS_SOURCE_DIR'] ?? file.sourceDir ?? './images/source');
  const optimizedDir = path.resolve(
    process.env['RIS_OPTIMIZED_DIR'] ?? file.optimizedDir ?? './images/optimized');
  const manifestPath = path.resolve(
    process.env['RIS_MANIFEST_PATH'] ?? file.manifestPath ?? './images/manifest.json');

  for (const dir of [sourceDir, optimizedDir, path.dirname(manifestPath)]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.fatal({ dir, err }, `Failed to create directory: ${dir}`);
      process.exit(2);
    }
  }

  return { port, sourceDir, optimizedDir, manifestPath, hashLength, avifQuality, avifEffort, fairnessMultiplier, watch, scanOnStart, asyncIo, stabilizeMs, stabilizePollMs, stabilizeTimeoutMs };
}
