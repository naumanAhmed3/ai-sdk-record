import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * One recorded interaction. Generate calls capture the resolved
 * `LanguageModelV2 generate result`; stream calls capture every chunk emitted
 * by the underlying stream so they can be replayed in order.
 */
export interface CassetteEntry {
  /** Stable hash of the call options that produced this entry. */
  key: string;

  /** The mode the call was made in. */
  kind: 'generate' | 'stream';

  /**
   * The serialised result. For `generate`, this is the full
   * `LanguageModelV2 generate result`. For `stream`, this is `{ chunks, request, response }`
   * with `chunks` being every event yielded by the underlying stream.
   */
  payload: unknown;

  /** Wall-clock timestamp the entry was recorded, in milliseconds since epoch. */
  recordedAt: number;
}

/**
 * Persisted cassette envelope. The version field lets us evolve the schema
 * without silently breaking older saved cassettes.
 */
export interface CassetteFile {
  version: 1;
  entries: CassetteEntry[];
}

/**
 * Cassette storage backend. Implement this to plug in alternative stores
 * (an in-memory map for tests, an S3 bucket for CI cache, etc.).
 */
export interface CassetteStorage {
  read(path: string): CassetteFile | null;
  write(path: string, file: CassetteFile): void;
}

/**
 * Default filesystem-backed storage. The cassette path can be anything
 * `fs.writeFileSync` accepts — we just ensure the parent directory exists.
 */
export const fileSystemStorage: CassetteStorage = {
  read(path) {
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as CassetteFile;
      if (parsed.version !== 1) {
        throw new Error(
          `ai-sdk-record: unsupported cassette version ${parsed.version} at ${path}`,
        );
      }
      return parsed;
    } catch (err) {
      throw new Error(
        `ai-sdk-record: failed to read cassette at ${path}: ${(err as Error).message}`,
      );
    }
  },
  write(path, file) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(file, null, 2));
  },
};

/**
 * Stable cassette key from any JSON-serialisable input. We sort keys before
 * hashing so {a:1,b:2} and {b:2,a:1} share an entry — call-option ordering
 * shouldn't force a re-record.
 */
export function hashKey(input: unknown): string {
  const stable = stableStringify(input);
  return createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(
        k =>
          JSON.stringify(k) +
          ':' +
          stableStringify((value as Record<string, unknown>)[k]),
      )
      .join(',') +
    '}'
  );
}

/**
 * In-memory storage backend. Useful in tests that don't want to touch the
 * filesystem.
 */
export function inMemoryStorage(): CassetteStorage & {
  files: Map<string, CassetteFile>;
} {
  const files = new Map<string, CassetteFile>();
  return {
    files,
    read(path) {
      return files.get(path) ?? null;
    },
    write(path, file) {
      files.set(path, file);
    },
  };
}
