import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { hashKey, inMemoryStorage, record, replay } from './index';

const fakeCall: LanguageModelV4CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
} as unknown as LanguageModelV4CallOptions;

function generateResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: [],
  } as unknown as LanguageModelV4GenerateResult;
}

function streamResult(chunks: unknown[]): LanguageModelV4StreamResult {
  const stream = new ReadableStream<unknown>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return {
    stream,
    request: {},
    response: { headers: {} },
  } as unknown as LanguageModelV4StreamResult;
}

function mockModel(overrides: Partial<LanguageModelV4>): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock',
    supportedUrls: {},
    doGenerate: vi.fn(async () => generateResult('mock')),
    doStream: vi.fn(async () => streamResult([])),
    ...overrides,
  } as LanguageModelV4;
}

describe('hashKey', () => {
  it('is stable across object key order', () => {
    expect(hashKey({ a: 1, b: 2 })).toBe(hashKey({ b: 2, a: 1 }));
  });
  it('differs when payload differs', () => {
    expect(hashKey({ a: 1 })).not.toBe(hashKey({ a: 2 }));
  });
});

describe('record', () => {
  it('returns the real model result and writes a cassette entry (generate)', async () => {
    const storage = inMemoryStorage();
    const upstream = mockModel({
      doGenerate: vi.fn(async () => generateResult('real')),
    });

    const m = record(upstream, { cassette: 'a.json', storage });
    const r = await m.doGenerate(fakeCall);

    expect((r.content[0] as any).text).toBe('real');
    expect(storage.files.get('a.json')!.entries).toHaveLength(1);
    expect(storage.files.get('a.json')!.entries[0].kind).toBe('generate');
  });

  it('serves a cached generate response on a second call', async () => {
    const storage = inMemoryStorage();
    const doGenerate = vi.fn(async () => generateResult('once'));
    const upstream = mockModel({ doGenerate });
    const m = record(upstream, { cassette: 'a.json', storage });

    await m.doGenerate(fakeCall);
    await m.doGenerate(fakeCall);

    expect(doGenerate).toHaveBeenCalledTimes(1);
  });

  it('re-records when forceRefresh is true', async () => {
    const storage = inMemoryStorage();
    const doGenerate = vi.fn(async () => generateResult('once'));
    const upstream = mockModel({ doGenerate });

    const m = record(upstream, {
      cassette: 'a.json',
      storage,
      forceRefresh: true,
    });

    await m.doGenerate(fakeCall);
    await m.doGenerate(fakeCall);

    expect(doGenerate).toHaveBeenCalledTimes(2);
  });

  it('captures stream chunks and persists them after stream completes', async () => {
    const storage = inMemoryStorage();
    const upstream = mockModel({
      doStream: vi.fn(async () =>
        streamResult([
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'hi' },
          { type: 'text-end', id: '0' },
        ]),
      ),
    });

    const m = record(upstream, { cassette: 'b.json', storage });
    const r = await m.doStream(fakeCall);

    // Drain the passthrough stream
    const reader = r.stream.getReader();
    const chunks: unknown[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    // tee promise resolves on a microtask after close — give it a tick
    await new Promise(setImmediate);

    expect(chunks).toHaveLength(3);
    const entry = storage.files.get('b.json')!.entries[0];
    expect(entry.kind).toBe('stream');
    expect((entry.payload as any).chunks).toHaveLength(3);
  });
});

describe('replay', () => {
  it('serves recorded generate responses without hitting any fallback', async () => {
    const storage = inMemoryStorage();
    const upstream = mockModel({
      doGenerate: vi.fn(async () => generateResult('recorded')),
    });

    // Record once
    const rec = record(upstream, { cassette: 'c.json', storage });
    await rec.doGenerate(fakeCall);

    // Replay shouldn't touch the upstream model at all
    const rep = replay({ cassette: 'c.json', storage });
    const r = await rep.doGenerate(fakeCall);
    expect((r.content[0] as any).text).toBe('recorded');
  });

  it('throws on a miss by default', async () => {
    const storage = inMemoryStorage();
    const rep = replay({ cassette: 'missing.json', storage });
    await expect(rep.doGenerate(fakeCall)).rejects.toThrow(
      /no recorded generate entry/,
    );
  });

  it('passes through to fallback when configured', async () => {
    const storage = inMemoryStorage();
    const fallback = mockModel({
      doGenerate: vi.fn(async () => generateResult('fallback')),
    });
    const rep = replay({
      cassette: 'missing.json',
      storage,
      onMiss: 'passthrough',
      fallback,
    });

    const r = await rep.doGenerate(fakeCall);
    expect((r.content[0] as any).text).toBe('fallback');
  });

  it('round-trips streams', async () => {
    const storage = inMemoryStorage();
    const upstream = mockModel({
      doStream: vi.fn(async () =>
        streamResult([
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'replay' },
          { type: 'text-end', id: '0' },
        ]),
      ),
    });

    const rec = record(upstream, { cassette: 'd.json', storage });
    {
      const r = await rec.doStream(fakeCall);
      const reader = r.stream.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      await new Promise(setImmediate);
    }

    const rep = replay({ cassette: 'd.json', storage });
    const r = await rep.doStream(fakeCall);
    const reader = r.stream.getReader();
    const got: unknown[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got.push(value);
    }
    expect(got).toHaveLength(3);
    expect((got[1] as any).delta).toBe('replay');
  });
});
