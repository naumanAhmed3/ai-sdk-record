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
  type CassetteFile,
  type CassetteStorage,
} from './cassette';

/**
 * Options accepted by both `record` and `replay`.
 */
export interface RecordOptions {
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
   * If `true`, re-recording always re-runs the underlying call and
   * overwrites any existing entry for the same key. If `false` (default),
   * existing entries are reused — which gives you cheap deterministic test
   * runs without burning tokens.
   */
  forceRefresh?: boolean;
}

/**
 * Wrap a `LanguageModelV4` so that every `doGenerate` / `doStream` call is
 * recorded into a cassette file. On subsequent runs the cached entry is
 * returned without hitting the real model — unless `forceRefresh` is set.
 *
 * ```ts
 * import { record } from 'ai-sdk-record';
 * import { openai } from '@ai-sdk/openai';
 *
 * const model = record(openai('gpt-4o-mini'), {
 *   cassette: 'tests/cassettes/weather-agent.json',
 * });
 *
 * // First run: hits OpenAI, writes the response to the cassette.
 * // Every other run: reads from the cassette, no network call.
 * await generateText({ model, prompt: 'What's the weather in Lahore?' });
 * ```
 */
export function record(
  model: LanguageModelV4,
  options: RecordOptions,
): LanguageModelV4 {
  const storage = options.storage ?? fileSystemStorage;
  const cassettePath = options.cassette;

  // Lazy: load the cassette only when needed. We re-read on every call so
  // multiple tests sharing the same cassette see each other's writes within
  // a single process.
  const readCassette = (): CassetteFile => {
    const existing = storage.read(cassettePath);
    return existing ?? { version: 1, entries: [] };
  };

  const writeEntry = (entry: CassetteEntry): void => {
    const file = readCassette();
    const idx = file.entries.findIndex(e => e.key === entry.key);
    if (idx >= 0) {
      file.entries[idx] = entry;
    } else {
      file.entries.push(entry);
    }
    storage.write(cassettePath, file);
  };

  const findEntry = (
    kind: CassetteEntry['kind'],
    key: string,
  ): CassetteEntry | undefined => {
    if (options.forceRefresh) return undefined;
    const file = readCassette();
    return file.entries.find(e => e.kind === kind && e.key === key);
  };

  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,

    async doGenerate(
      callOptions: LanguageModelV4CallOptions,
    ): Promise<LanguageModelV4GenerateResult> {
      const key = hashKey({ kind: 'generate', call: callOptions });
      const cached = findEntry('generate', key);
      if (cached !== undefined) {
        return cached.payload as LanguageModelV4GenerateResult;
      }

      const result = await model.doGenerate(callOptions);
      writeEntry({
        key,
        kind: 'generate',
        payload: result,
        recordedAt: Date.now(),
      });
      return result;
    },

    async doStream(
      callOptions: LanguageModelV4CallOptions,
    ): Promise<LanguageModelV4StreamResult> {
      const key = hashKey({ kind: 'stream', call: callOptions });
      const cached = findEntry('stream', key);
      if (cached !== undefined) {
        const recorded = cached.payload as {
          chunks: unknown[];
          request?: unknown;
          response?: unknown;
        };
        return replayChunks(recorded);
      }

      const live = await model.doStream(callOptions);
      const teed = teeAndCapture(live);

      // Persist after the stream completes — we don't know what chunks will
      // arrive synchronously.
      teed.collected.then(payload =>
        writeEntry({
          key,
          kind: 'stream',
          payload,
          recordedAt: Date.now(),
        }),
      );

      return {
        ...live,
        stream: teed.passthrough,
      };
    },
  };
}

/**
 * Tee a stream into a copy the caller consumes and a capture buffer we drain
 * to persist. Returns a passthrough stream plus a promise that resolves to
 * the recorded payload once the stream completes.
 */
function teeAndCapture(live: LanguageModelV4StreamResult): {
  passthrough: ReadableStream<unknown>;
  collected: Promise<{ chunks: unknown[]; request?: unknown; response?: unknown }>;
} {
  const collectedChunks: unknown[] = [];
  let resolveCollected!: (
    v: { chunks: unknown[]; request?: unknown; response?: unknown },
  ) => void;
  let rejectCollected!: (e: unknown) => void;
  const collected = new Promise<{
    chunks: unknown[];
    request?: unknown;
    response?: unknown;
  }>((res, rej) => {
    resolveCollected = res;
    rejectCollected = rej;
  });

  const reader = live.stream.getReader();
  const passthrough = new ReadableStream<unknown>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          resolveCollected({
            chunks: collectedChunks,
            request: live.request,
            response: live.response,
          });
          return;
        }
        collectedChunks.push(value);
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        rejectCollected(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason);
      resolveCollected({
        chunks: collectedChunks,
        request: live.request,
        response: live.response,
      });
    },
  });

  return { passthrough, collected };
}

/**
 * Re-emit chunks from a recorded stream payload. Returns a fresh
 * `LanguageModelV4StreamResult` whose `stream` enqueues all captured chunks
 * synchronously and then closes.
 */
export function replayChunks(recorded: {
  chunks: unknown[];
  request?: unknown;
  response?: unknown;
}): LanguageModelV4StreamResult {
  const { chunks, request, response } = recorded;
  const stream = new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return {
    stream,
    request: (request ?? {}) as LanguageModelV4StreamResult['request'],
    response: (response ?? {
      headers: {},
    }) as LanguageModelV4StreamResult['response'],
  } as LanguageModelV4StreamResult;
}
