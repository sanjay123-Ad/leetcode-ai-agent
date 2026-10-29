/**
 * The single Gemini entry point for both the web app and the CLI.
 *
 * Previously every route built its own prompt and called the SDK with no retry, no
 * timeout and no usage accounting, so a transient 503 killed a whole run (audit finding
 * C6). This client goes through `requestJson`, which retries 429/5xx with backoff, and it
 * reports token usage so cost claims can be measured instead of guessed.
 */

import { config } from './config.ts';
import { requestJson } from './http.ts';

export class GeminiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.retryable = retryable;
  }
}

export type GenerateOptions = {
  prompt: string;
  maxOutputTokens: number;
  /** Ask for `application/json` and a lower temperature. */
  json?: boolean;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  label?: string;
};

export type GenerateResult = {
  text: string;
  finishReason?: string;
  /** True when the model hit the output cap, so the text is probably incomplete. */
  truncated: boolean;
  promptTokens: number;
  outputTokens: number;
  durationMs: number;
  attempts: number;
};

type GeminiResponse = {
  error?: { code?: number; status?: string; message?: string };
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; thought?: boolean }[] };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};

export class GeminiClient {
  readonly model: string;
  private readonly apiKey: string;
  private calls = 0;
  private promptTokens = 0;
  private outputTokens = 0;

  constructor(options: { model?: string; apiKey?: string } = {}) {
    this.model = options.model ?? config.geminiModel();
    this.apiKey = options.apiKey ?? config.geminiApiKey();
  }

  usage() {
    return { geminiCalls: this.calls, promptTokens: this.promptTokens, outputTokens: this.outputTokens };
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const { prompt, maxOutputTokens, json = false, temperature, timeoutMs = 90_000, signal } = options;

    const generationConfig: Record<string, unknown> = { maxOutputTokens };
    if (json) generationConfig.responseMimeType = 'application/json';
    if (temperature !== undefined) generationConfig.temperature = temperature;

    this.calls++;
    const res = await requestJson<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
        timeoutMs,
        retries: 4,
        signal,
      },
    );

    if (res.transportError) {
      throw new GeminiError(`Gemini request failed (${res.transportError})`, 0, true);
    }

    const payload = res.data;
    if (!res.ok || payload?.error) {
      const status = payload?.error?.code ?? res.status;
      const message = payload?.error?.message ?? res.body.slice(0, 300) ?? 'unknown error';
      throw new GeminiError(`Gemini ${status}: ${message}`, status, [429, 500, 502, 503, 504].includes(status));
    }

    const candidate = payload?.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');

    this.promptTokens += payload?.usageMetadata?.promptTokenCount ?? 0;
    this.outputTokens +=
      (payload?.usageMetadata?.candidatesTokenCount ?? 0) + (payload?.usageMetadata?.thoughtsTokenCount ?? 0);

    const finishReason = candidate?.finishReason;
    if (!text.trim()) {
      throw new GeminiError(
        `Gemini returned no text (finishReason=${finishReason ?? 'unknown'}). ` +
          (finishReason === 'MAX_TOKENS'
            ? 'The output cap was reached before any text was produced; raise maxOutputTokens.'
            : 'The model may have blocked the response.'),
        200,
        finishReason === 'MAX_TOKENS',
      );
    }

    return {
      text,
      finishReason,
      truncated: finishReason === 'MAX_TOKENS',
      promptTokens: payload?.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: payload?.usageMetadata?.candidatesTokenCount ?? 0,
      durationMs: res.durationMs,
      attempts: res.attempts,
    };
  }
}

/** Strips markdown fences and any prose the model wrapped around a Java block. */
export function extractJavaCode(raw: string): string {
  const text = raw.trim();

  // Prefer an explicit fenced block when one is present.
  const fenced = /```(?:java)?\s*\n([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).replace(/```java/gi, '').replace(/```/g, '');

  const lines = body.split('\n');
  // Drop leading prose: real Java starts at an import, package, annotation, comment or declaration.
  const start = lines.findIndex((line) =>
    /^\s*(import\s|package\s|@|\/\*|\/\/|public\s|private\s|final\s|abstract\s|class\s|interface\s|enum\s)/.test(line),
  );

  return (start >= 0 ? lines.slice(start) : lines).join('\n').trim();
}

/** Parses a JSON object out of a model response that may still carry prose or fences. */
export function extractJsonObject<T>(raw: string): T | undefined {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(raw);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(raw);

  const braced = /\{[\s\S]*\}/.exec(raw);
  if (braced) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as T;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
