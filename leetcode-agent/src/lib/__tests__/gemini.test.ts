import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient, GeminiError, extractJavaCode, extractJsonObject } from '../gemini.ts';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  vi.restoreAllMocks();
});

function mockGemini(payloads: unknown[], status = 200) {
  let index = 0;
  globalThis.fetch = vi.fn(async () => {
    const payload = payloads[Math.min(index++, payloads.length - 1)];
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const candidate = (text: string, finishReason = 'STOP') => ({
  candidates: [{ finishReason, content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
});

describe('extractJavaCode', () => {
  it('unwraps a fenced block', () => {
    expect(extractJavaCode('```java\nclass Solution {}\n```')).toBe('class Solution {}');
  });

  it('drops prose before the code', () => {
    const raw = 'Sure! Here is the solution:\n\nclass Solution {\n  public int f() { return 1; }\n}';
    expect(extractJavaCode(raw).startsWith('class Solution')).toBe(true);
  });

  it('keeps imports at the top', () => {
    const raw = 'Here you go:\nimport java.util.*;\nclass Solution {}';
    expect(extractJavaCode(raw)).toBe('import java.util.*;\nclass Solution {}');
  });

  it('keeps a leading comment block', () => {
    expect(extractJavaCode('// note\nclass Solution {}')).toBe('// note\nclass Solution {}');
  });
});

describe('extractJsonObject', () => {
  it('parses plain JSON', () => {
    expect(extractJsonObject<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON inside a fenced block', () => {
    expect(extractJsonObject<{ a: number }>('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('parses JSON surrounded by prose', () => {
    expect(extractJsonObject<{ a: number }>('Here it is: {"a":3} — hope that helps')).toEqual({ a: 3 });
  });

  it('returns undefined for unparseable text', () => {
    expect(extractJsonObject('not json at all')).toBeUndefined();
  });
});

describe('GeminiClient', () => {
  it('returns text and accumulates usage', async () => {
    mockGemini([candidate('class Solution {}')]);
    const client = new GeminiClient();
    const result = await client.generate({ prompt: 'x', maxOutputTokens: 100 });

    expect(result.text).toBe('class Solution {}');
    expect(result.truncated).toBe(false);
    expect(client.usage()).toEqual({ geminiCalls: 1, promptTokens: 10, outputTokens: 5 });
  });

  it('ignores thought parts when collecting text', async () => {
    mockGemini([
      {
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking…', thought: true }, { text: 'answer' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      },
    ]);
    const result = await new GeminiClient().generate({ prompt: 'x', maxOutputTokens: 10 });
    expect(result.text).toBe('answer');
  });

  it('flags truncation when the output cap is hit', async () => {
    mockGemini([candidate('class Solution { // cut off', 'MAX_TOKENS')]);
    const result = await new GeminiClient().generate({ prompt: 'x', maxOutputTokens: 10 });
    expect(result.truncated).toBe(true);
  });

  it('raises a classified error for an API error payload', async () => {
    mockGemini([{ error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } }], 503);
    await expect(new GeminiClient().generate({ prompt: 'x', maxOutputTokens: 10 })).rejects.toMatchObject({
      name: 'GeminiError',
      status: 503,
      retryable: true,
    });
  });

  it('explains an empty response caused by the token cap', async () => {
    mockGemini([{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }]);
    await expect(new GeminiClient().generate({ prompt: 'x', maxOutputTokens: 10 })).rejects.toThrow(/maxOutputTokens/);
  });

  it('requires an API key, lazily', () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => new GeminiClient()).toThrow(/GEMINI_API_KEY/);
  });

  it('honours a configured model override', () => {
    process.env.GEMINI_MODEL = 'gemini-3.5-flash';
    expect(new GeminiClient().model).toBe('gemini-3.5-flash');
  });

  it('defaults to the cheap model', () => {
    expect(new GeminiClient().model).toBe('gemini-3.5-flash-lite');
  });

  it('sends the key in a header, never in the URL', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify(candidate('ok')), { status: 200 });
    }) as unknown as typeof fetch;

    await new GeminiClient().generate({ prompt: 'x', maxOutputTokens: 10 });
    expect(seen[0].url).not.toContain('test-key');
    expect((seen[0].init?.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
  });

  it('is an Error subclass so callers can catch it normally', () => {
    expect(new GeminiError('x', 500, true)).toBeInstanceOf(Error);
  });
});
