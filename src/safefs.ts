/**
 * Write-path guard.
 *
 * Project invariant: the source directory (`cfg.sourceDir`) is READ-ONLY.
 * The server may stat / read / watch source files, but must never create,
 * modify, rename, or delete anything inside it.
 *
 * To enforce this defensively, every filesystem write in this codebase
 * goes through one of the helpers below. Each helper resolves the target
 * path and rejects it unless it sits under one of the writable roots
 * registered at startup (the optimized directory and the manifest's
 * containing directory).
 *
 * A deny list registered alongside the roots (the source directory) takes
 * precedence: paths under a denied root are rejected even when a writable
 * root would cover them, so layouts where a writable root happens to
 * contain sourceDir cannot punch through the guard.
 *
 * If you find yourself wanting to disable this check, don't — add a new
 * writable root via `initSafeFs` instead, and document why.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

let writableRoots: string[] | null = null;
let deniedRoots: string[] = [];

export function initSafeFs(roots: string[], denied: string[] = []): void {
  // Resolve + normalize once, with a trailing separator so that
  // `/a/b` does not accidentally match `/a/bc`.
  const normalize = (list: string[]): string[] =>
    list.map((r) => {
      const resolved = path.resolve(r);
      return resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
    });
  writableRoots = normalize(roots);
  deniedRoots = normalize(denied);
}

/** True if `target` resolves to a path inside one of the writable roots. */
function isWritable(target: string): boolean {
  if (!writableRoots) {
    // Fail closed: no roots registered means no writes allowed.
    return false;
  }
  const resolved = path.resolve(target);
  if (isDenied(resolved)) return false;
  // A write *to* the root itself is not meaningful (you'd be writing a
  // file at that exact path, which is fine if the root has a trailing
  // sep added — covered below). We accept either "inside root" or
  // "exactly at root" (the latter for completeness).
  for (const root of writableRoots) {
    if (resolved === root.slice(0, -1)) return true;
    if (resolved.startsWith(root)) return true;
  }
  return false;
}

/**
 * Denied roots win over writable roots — this is what actually protects
 * sourceDir under the default layout, where dirname(manifestPath) is its
 * parent. The one exception: a writable root nested *inside* a denied
 * root keeps working, so exotic layouts (optimizedDir under sourceDir)
 * are not broken by the deny rule.
 */
function isDenied(resolved: string): boolean {
  for (const denied of deniedRoots) {
    const under = resolved === denied.slice(0, -1) || resolved.startsWith(denied);
    if (!under) continue;
    const carved = writableRoots!.some(
      (w) =>
        w !== denied &&
        w.startsWith(denied) &&
        (resolved === w.slice(0, -1) || resolved.startsWith(w)),
    );
    if (!carved) return true;
  }
  return false;
}

function assertWritable(target: string, op: string): void {
  if (!isWritable(target)) {
    const err = new Error(
      `safefs: refusing ${op} on '${target}' — path is not under any writable root. ` +
      `Writable roots: ${writableRoots ? writableRoots.join(', ') : '(none)'}`,
    );
    (err as NodeJS.ErrnoException).code = 'EWRITEFORBIDDEN';
    throw err;
  }
}

// --- async wrappers ---------------------------------------------------------

export async function writeFile(target: string, data: Buffer | string): Promise<void> {
  assertWritable(target, 'writeFile');
  await fsp.writeFile(target, data);
}

export async function rename(from: string, to: string): Promise<void> {
  assertWritable(from, 'rename(src)');
  assertWritable(to, 'rename(dst)');
  await fsp.rename(from, to);
}

export async function unlink(target: string): Promise<void> {
  assertWritable(target, 'unlink');
  await fsp.unlink(target);
}

// --- sync wrappers ----------------------------------------------------------

export function writeFileSync(target: string, data: Buffer | string, encoding?: BufferEncoding): void {
  assertWritable(target, 'writeFileSync');
  if (encoding !== undefined) {
    fs.writeFileSync(target, data, encoding);
  } else {
    fs.writeFileSync(target, data);
  }
}

export function renameSync(from: string, to: string): void {
  assertWritable(from, 'renameSync(src)');
  assertWritable(to, 'renameSync(dst)');
  fs.renameSync(from, to);
}

export function unlinkSync(target: string): void {
  assertWritable(target, 'unlinkSync');
  fs.unlinkSync(target);
}
