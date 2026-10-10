# ai-sdk-record

Record real [Vercel AI SDK](https://github.com/vercel/ai) calls into a cassette file, then replay them deterministically in tests. Inspired by VCR / nock — for the `LanguageModelV2` provider interface.

```bash
npm i -D ai-sdk-record
```

## Why

Anything you build on top of `streamText` / `generateText` / agents needs to be tested. The two existing options are:

1. **Mock the model by hand.** Tedious, fragile, and your tests diverge from production. Every new tool call or streaming protocol change means new mocks.
2. **Hit the real API in CI.** Slow, expensive, flaky, and forbidden in most CI environments.

`ai-sdk-record` gives you a third option: hit the real model **once**, capture every byte, and replay it forever. Your tests look like production code, run offline, are deterministic, and burn zero tokens after the initial recording.

## Quick start

### 1. Record

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { record } from 'ai-sdk-record';

const model = record(openai('gpt-4o-mini'), {
  cassette: 'tests/__cassettes__/weather-agent.json',
});

// First run: hits OpenAI, writes the cassette.
// Subsequent runs in the same process: serves from the cassette.
const result = await generateText({
  model,
  prompt: "What's the weather in Lahore?",
  tools: { /* ... */ },
});
```

### 2. Replay (in CI / tests)

```ts
import { generateText } from 'ai';
import { replay } from 'ai-sdk-record';

const model = replay({
  cassette: 'tests/__cassettes__/weather-agent.json',
});

// No network call. The cassette is the source of truth.
const result = await generateText({
  model,
  prompt: "What's the weather in Lahore?",
});
```

### 3. The typical workflow

In your test setup:

```ts
import { replay, record } from 'ai-sdk-record';
import { openai } from '@ai-sdk/openai';

const isRecording = process.env.AI_SDK_RECORD === '1';

export function testModel(cassette: string) {
  return isRecording
    ? record(openai('gpt-4o-mini'), { cassette })
    : replay({ cassette });
}
```

- Default `vitest run` → fast, offline, deterministic.
- `AI_SDK_RECORD=1 vitest run` → live recording (rare; only when prompts/tools change).

## What gets captured

Each cassette entry is keyed by a stable hash of the call options (`prompt`, `tools`, model parameters). Two calls with the same options share an entry. Object key ordering doesn't matter — `{a: 1, b: 2}` and `{b: 2, a: 1}` hash the same.

Per call kind we record:

| Kind | Payload |
| --- | --- |
| `doGenerate` | the full `LanguageModelV4GenerateResult` |
| `doStream` | every chunk yielded by the upstream stream, plus `request` / `response` metadata |

Streaming replay re-emits every recorded chunk in order, so tool-call deltas, reasoning frames, and finish events all arrive exactly as they did during recording.

## API

### `record(model, options)`

```ts
record(model: LanguageModelV2, options: {
  cassette: string;
  storage?: CassetteStorage;
  forceRefresh?: boolean;
  redact?: (payload: unknown) => unknown;
}): LanguageModelV4;
```

- `cassette` — path passed to the storage backend.
- `storage` — defaults to a filesystem storage that reads/writes JSON. Swap for `inMemoryStorage()` in unit tests or your own implementation for S3 / R2 / etc.
- `forceRefresh` — when `true`, every call hits the underlying model and overwrites the existing entry. Useful for one-off cassette refreshes; you usually leave this off.

### `replay(options)`

```ts
replay(options: {
  cassette: string;
  storage?: CassetteStorage;
  onMiss?: 'throw' | 'passthrough';
  fallback?: LanguageModelV4;
  provider?: string;
  modelId?: string;
}): LanguageModelV4;
```

- `onMiss: 'throw'` (default) — fail loud on missing entries. Best in CI.
- `onMiss: 'passthrough'` — forward unknown requests to a `fallback` model. Useful during local development when you're authoring a new test.

### `inMemoryStorage()`

A no-IO storage backed by a `Map<string, CassetteFile>`. Returns an object that also exposes the `files` map so you can assert on cassette contents in unit tests.

### `hashKey(input)`

Exposed so test setups can pre-compute keys (e.g. to seed an inMemory cassette before exercising the model).

## Streaming semantics

Cassette playback re-emits every captured chunk synchronously on consumption. Errors during the original stream are *not* captured: the recorder writes the cassette only on stream completion, so an error before the close event is left out. This is intentional — the goal is reproducible **happy-path** replay; error paths should be tested by deliberately throwing in your transport mock, not by replaying a half-finished stream.

## Comparison

| | Manual mocks | Live API in tests | **ai-sdk-record** |
| --- | --- | --- | --- |
| Deterministic | ✅ | ❌ | ✅ |
| Free | ✅ | ❌ | ✅ (after first record) |
| Offline | ✅ | ❌ | ✅ |
| Mirrors production wire format | ❌ | ✅ | ✅ |
| Survives SDK upgrades | ❌ (rewrite mocks) | ✅ | ⚠️ (re-record when chunk shapes change) |

## Status

Pre-1.0. Cassettes can contain prompts and model output; keep them out of public
repositories when that content is confidential. Common credential metadata is
redacted by default and `redact` can enforce project-specific rules. Filesystem
writes use an atomic replace, but one cassette should still have a single writer
at a time. The cassette format is versioned and will be migrated rather than broken.

## License

MIT © [Nouman Misbah](https://github.com/naumanAhmed3)
