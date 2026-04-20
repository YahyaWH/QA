import { setTimeout as delay } from 'node:timers/promises';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Thrown when the model returns text that cannot be parsed as JSON even after a single
 * reprompt attempt. The raw response from the final (failed) attempt is attached.
 */
export class MalformedJsonError extends Error {
  constructor(
    message: string,
    public readonly rawResponse: string,
  ) {
    super(message);
    this.name = 'MalformedJsonError';
  }
}

export interface ClaudeClientOptions {
  apiKey: string;
  model: string;
  /** Defaults to 4096. */
  maxTokens?: number;
  /** Inject a pre-constructed Anthropic SDK client (used by tests). */
  anthropic?: Anthropic;
  /** Inject a sleep function (used by tests to avoid real waits). */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface CallJsonParams {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** If true, the system block is marked `cache_control: ephemeral`. */
  cacheControl?: boolean;
}

export interface CallJsonWithImageParams extends CallJsonParams {
  imageBase64: string;
  imageMediaType: 'image/png' | 'image/jpeg';
}

type AnthropicMinimal = {
  messages: {
    create: (body: unknown) => Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
};

/** Backoff schedule in ms. 5 attempts total => 4 sleeps between them. */
const HTTP_BACKOFF_MS = [1000, 2000, 4000, 8000, 30000] as const;

const REPROMPT_TEXT =
  'Your previous response was not valid JSON. Please respond with ONLY valid JSON, no prose or code fences.';

/**
 * Thin wrapper over the Anthropic Messages API that returns parsed JSON.
 *
 * Adds two narrowly-scoped reliability layers:
 *   1. HTTP retry with exponential backoff on 429/5xx (5 attempts).
 *   2. One-shot JSON-parse retry with a reprompt if the model emits bad JSON.
 *
 * Both the SDK client and the sleep implementation are injectable so tests can
 * exercise every branch without touching the network or the real clock.
 */
export class ClaudeClient {
  private readonly anthropic: AnthropicMinimal;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(opts: ClaudeClientOptions) {
    this.anthropic =
      (opts.anthropic as unknown as AnthropicMinimal) ??
      (new Anthropic({ apiKey: opts.apiKey }) as unknown as AnthropicMinimal);
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 4096;
    this.sleepFn = opts.sleepFn ?? ((ms) => delay(ms));
  }

  async callJson<T = unknown>(params: CallJsonParams): Promise<T> {
    return this.runJsonCall<T>(this.buildRequest(params));
  }

  async callJsonWithImage<T = unknown>(params: CallJsonWithImageParams): Promise<T> {
    return this.runJsonCall<T>(this.buildRequestWithImage(params));
  }

  private buildRequest(params: CallJsonParams): Record<string, unknown> {
    const system = params.cacheControl
      ? [
          {
            type: 'text',
            text: params.system,
            cache_control: { type: 'ephemeral' },
          },
        ]
      : params.system;
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
    };
  }

  private buildRequestWithImage(params: CallJsonWithImageParams): Record<string, unknown> {
    const base = this.buildRequest(params);
    const messages = [...(base.messages as Array<{ role: string; content: unknown }>)];
    if (messages.length === 0) {
      throw new Error('callJsonWithImage requires at least one message');
    }
    const lastIdx = messages.length - 1;
    const last = messages[lastIdx];
    if (last.role !== 'user') {
      throw new Error('callJsonWithImage requires the last message to be from the user');
    }
    messages[lastIdx] = {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: params.imageMediaType,
            data: params.imageBase64,
          },
        },
        { type: 'text', text: last.content as string },
      ],
    };
    return { ...base, messages };
  }

  /**
   * Perform the HTTP call (with 429/5xx backoff) and parse JSON. On the first
   * JSON parse failure, append a reprompt and reuse the same retry loop for one
   * more attempt. On second parse failure, throw MalformedJsonError.
   */
  private async runJsonCall<T>(request: Record<string, unknown>): Promise<T> {
    const firstText = await this.callWithHttpRetry(request);
    try {
      return JSON.parse(stripFences(firstText)) as T;
    } catch {
      // Fall through to reprompt.
    }

    const reprompted: Record<string, unknown> = {
      ...request,
      messages: [
        ...(request.messages as Array<{ role: string; content: unknown }>),
        { role: 'assistant', content: firstText },
        { role: 'user', content: REPROMPT_TEXT },
      ],
    };
    const secondText = await this.callWithHttpRetry(reprompted);
    try {
      return JSON.parse(stripFences(secondText)) as T;
    } catch (e) {
      throw new MalformedJsonError(
        `Model returned invalid JSON after reprompt: ${(e as Error).message}`,
        secondText,
      );
    }
  }

  /**
   * Call `messages.create` with exponential backoff on retriable HTTP errors
   * (429 and 5xx). Non-retriable errors propagate immediately. After 5 failed
   * attempts, the last error is thrown.
   */
  private async callWithHttpRetry(request: Record<string, unknown>): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < HTTP_BACKOFF_MS.length; attempt++) {
      try {
        const response = await this.anthropic.messages.create(request);
        return extractText(response);
      } catch (e) {
        lastErr = e;
        if (!isRetriable(e) || attempt === HTTP_BACKOFF_MS.length - 1) {
          throw e;
        }
        await this.sleepFn(HTTP_BACKOFF_MS[attempt]);
      }
    }
    throw lastErr;
  }
}

function isRetriable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status !== 'number') return false;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

function extractText(response: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const block = response.content.find((b) => b.type === 'text');
  if (!block || typeof block.text !== 'string') {
    throw new Error('Response contained no text block');
  }
  return block.text;
}

/**
 * Strip surrounding markdown code fences from a model response. Handles both
 * ```json fenced blocks and plain ``` fences. Trims whitespace at the edges.
 */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(trimmed);
  if (fenced) return fenced[1].trim();
  return trimmed;
}
