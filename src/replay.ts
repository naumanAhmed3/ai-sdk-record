import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import {
  fileSystemStorage,
  hashKey,
  type CassetteEntry,
  type CassetteStorage,
} from './cassette';
import { replayChunks } from './record';

/**
 * Options for `replay`.
 */
export interface ReplayOptions {
  /**
   * Path to the cassette file. With the default filesystem storage this is a
   * filesystem path; with a custom `storage` it can be any identifier the
   * storage understands.
   */
  cassette: string;

  /**
   * Optional storage backend. Defaults to filesystem.
   */
  storage?: CassetteStorage;

  /**
   * Provider id to advertise on the returned model. Defaults to
   * `'ai-sdk-record/replay'`.
   */
  provider?: string;

  /**
   * Model id to advertise. Defaults to `'replay'`.
   */
  modelId?: string;

  /**
   * Behaviour when a request is made for which no recorded entry exists.
   *
   * - `'throw'` (default): throw a descriptive error. Best in CI — surfaces
   *   the need to re-record.
   * - `'passthrough'`: requires a `fallback` model option; the call is
   *   forwarded to it. Useful during local development.
   */
  onMiss?: 'throw' | 'passthrough';

  /**
   * Model to delegate to when `onMiss: 'passthrough'` and no cached entry is
   * found.
   */
  fallback?: LanguageModelV4;
}

/**
 * Return a `LanguageModelV4` that serves all calls from a pre-recorded
 * cassette. Use this in tests / CI to drop the dependency on real model
 * providers entirely.
 *
 * ```ts
 * import { replay } from 'ai-sdk-record';
 *
 * const model = replay({ cassette: 'tests/cassettes/weather-agent.json' });
 *
 * // No network call; the streamed/generated response comes from the cassette.
 * await generateText({ model, prompt: 'What's the weather in Lahore?' });
 * ```
 */
export function replay(options: ReplayOptions): LanguageModelV4 {
  const storage = options.storage ?? fileSystemStorage;
  const cassettePath = options.cassette;
  const onMiss = options.onMiss ?? 'throw';

  const findEntry = (
    kind: CassetteEntry['kind'],
    key: string,
  ): CassetteEntry | undefined => {
    const file = storage.read(cassettePath);
    return file?.entries.find(e => e.kind === kind && e.key === key);
  };

  const missError = (kind: string, key: string): Error =>
    new Error(
      `ai-sdk-record/replay: no recorded ${kind} entry for key ${key} in cassette ${cassettePath}. ` +
        `Re-record by switching to record() with the same options, or set onMiss: 'passthrough' + a fallback model during development.`,
    );

  return {
    specificationVersion: 'v4',
    provider: options.provider ?? 'ai-sdk-record/replay',
    modelId: options.modelId ?? 'replay',
    supportedUrls: {},

    async doGenerate(
      callOptions: LanguageModelV4CallOptions,
    ): Promise<LanguageModelV4GenerateResult> {
      const key = hashKey({ kind: 'generate', call: callOptions });
      const entry = findEntry('generate', key);
      if (entry !== undefined) {
        return entry.payload as LanguageModelV4GenerateResult;
      }
      if (onMiss === 'passthrough' && options.fallback !== undefined) {
        return options.fallback.doGenerate(callOptions);
      }
      throw missError('generate', key);
    },

    async doStream(
      callOptions: LanguageModelV4CallOptions,
    ): Promise<LanguageModelV4StreamResult> {
      const key = hashKey({ kind: 'stream', call: callOptions });
      const entry = findEntry('stream', key);
      if (entry !== undefined) {
        const recorded = entry.payload as {
          chunks: unknown[];
          request?: unknown;
          response?: unknown;
        };
        return replayChunks(recorded);
      }
      if (onMiss === 'passthrough' && options.fallback !== undefined) {
        return options.fallback.doStream(callOptions);
      }
      throw missError('stream', key);
    },
  };
}
