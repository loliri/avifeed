import crypto from 'node:crypto';

/**
 * Compute a content hash from bytes.
 * Returns the first `length` hex characters of SHA-256(bytes).
 */
export function contentHash(bytes: Buffer, length: number): string {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, length);
}
