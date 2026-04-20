import { describe, it, expect, vi } from 'vitest';
import { ClaudeClient, MalformedJsonError } from './claude';

interface FakeAnthropicOptions {
  responses?: Array<
    | { kind: 'ok'; text: string }
    | { kind: 'err'; status?: number; message?: string }
  >;
}

/**
 * Build a fake Anthropic client whose `messages.create` returns / throws a predefined sequence.
 * Every call consumes the next entry. `calls` exposes the captured request bodies for assertions.
 */
function makeFakeAnthropic(opts: FakeAnthropicOptions = {}): {
  client: { messages: { create: ReturnType<typeof vi.fn> } };
  calls: unknown[];
} {
  const responses = opts.responses ?? [];
  const calls: unknown[] = [];
  let i = 0;
  const create = vi.fn(async (body: unknown) => {
    calls.push(body);
    const next = responses[i++];
    if (!next) throw new Error('fake anthropic: no more responses queued');
    if (next.kind === 'err') {
      const e = new Error(next.message ?? 'fake error');
      if (next.status !== undefined) (e as Error & { status: number }).status = next.status;
      throw e;
    }
    return { content: [{ type: 'text', text: next.text }] };
  });
  return {
    client: { messages: { create } },
    calls,
  };
}

describe('ClaudeClient.callJson', () => {
  it('returns parsed JSON on happy path', async () => {
    const { client, calls } = makeFakeAnthropic({
      responses: [{ kind: 'ok', text: '{"a":1}' }],
    });
    const sleepFn = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const cc = new ClaudeClient({
      apiKey: 'x',
      model: 'claude-opus-4-7',
      anthropic: client as never,
      sleepFn,
    });
    const result = await cc.callJson<{ a: number }>({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toEqual({ a: 1 });
    expect(calls.length).toBe(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('strips ```json ... ``` fences around the response', async () => {
    const { client } = makeFakeAnthropic({
      responses: [{ kind: 'ok', text: '```json\n{"a":1}\n```' }],
    });
    const cc = new ClaudeClient({
      apiKey: 'x',
      model: 'claude-opus-4-7',
      anthropic: client as never,
      sleepFn: async () => {},
    });
    const result = await cc.callJson<{ a: number }>({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toEqual({ a: 1 });
  });

  it('strips plain ``` fences around the response', async () => {
    const { client } = makeFakeAnthropic({
      responses: [{ kind: 'ok', text: '```\n{"b":2}\n```' }],
    });
    const cc = new ClaudeClient({
      apiKey: 'x',
      model: 'claude-opus-4-7',
      anthropic: client as never,
      sleepFn: async () => {},
    });
    const result = await cc.callJson<{ b: number }>({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toEqual({ b: 2 });
  });

  it('retries once with reprompt on malformed JSON then returns parsed result', async () => {
    const { client, calls } = makeFakeAnthropic({
      responses: [
        { kind: 'ok', text: '{"bad"' },
        { kind: 'ok', text: '{"good":1}' },
      ],
    });
    const cc = new ClaudeClient({
      apiKey: 'x',
      model: 'claude-opus-4-7',
      anthropic: client as never,
      sleepFn: async () => {},
    });
    const result = await cc.callJson<{ good: number }>({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toEqual({ good: 1 });
    expect(calls.length).toBe(2);
    const secondBody = calls[1] as {
      messages: Array<{ role: string; content: string }>;
    };
    // reprompt appends the previous assistant response and a user reprompt message
    expect(secondBody.messages.length).toBe(3);
    expect(secondBody.messages[1]).toEqual({
      role: 'assistant',
      content: '{"bad"',
    });
    expect(secondBody.messages[2].role).toBe('user');
    expect(secondBody.messages[2].content).toMatch(/valid JSON/i);
  });

  it('throws MalformedJsonError when JSON is invalid on both attempts', async () => {
    const { client } = makeFakeAnthropic({
      responses: [
        { kind: 'ok', text: '{"bad"' },
        { kind: 'ok', text: '{"also-bad"' },
      ],
    });
    const cc = new ClaudeClient({
      apiKey: 'x',
      model: 'claude-opus-4-7',
      anthropic: client as never,
      sleepFn: async () => {},
    });
    await expect(
      cc.callJson({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({
      name: 'MalformedJsonError',
      rawResponse: '{"also-bad"',
    });
  });

  it('retries on 429 with backoff=1000ms then returns parsed result', async () => {
    const { client } = makeFakeAnthropic({
      responses: [
        { kind: 'err', status: 429, message: 'rate limited' },
        { kind: 'ok', text: '{"ok":true}' },
      ],
    });
    const sleepFn = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const cc = new ClaudeClient({
      apiKey: 'x',
      model: 'claude-opus-4-7',
      anthropic: client as never,
      sleepFn,
    });
    const result = await cc.callJson<{ ok: boolean }>({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toEqual({ ok: true });
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledWith(1000);
  });

  it('throws the last error after 5 consecutive 5xx attempts with full backoff sequence', async () => {
    const { client } = makeFakeAnthropic({
      responses: [
        { kind: 'err', status: 500, message: 'boom-1' },
        { kind: 'err', status: 500, message: 'boom-2' },
        { kind: 'err', status: 500, message: 'boom-3' },
        { kind: 'err', status: 500, message: 'boom-4' },
        { kind: 'err', status: 500, message: 'boom-5' },
      ],
    });
    const sleepFn = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const cc = new ClaudeClient({
      apiKey: 'x',
      model: 'claude-opus-4-7',
      anthropic: client as never,
      sleepFn,
    });
    await expect(
      cc.callJson({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ message: 'boom-5' });
    expect(sleepFn).toHaveBeenCalledTimes(4);
    expect(sleepFn.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000, 8000]);
  });

  it('does not retry on 4xx other than 429', async () => {
    const { client, calls } = makeFakeAnthropic({
      responses: [{ kind: 'err', status: 401, message: 'unauthorized' }],
    });
    const sleepFn = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const cc = new ClaudeClient({
      apiKey: 'x',
      model: 'claude-opus-4-7',
      anthropic: client as never,
      sleepFn,
    });
    await expect(
      cc.callJson({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ message: 'unauthorized' });
    expect(calls.length).toBe(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('sends system as a cache-controlled block when cacheControl is true', async () => {
    const { client, calls } = makeFakeAnthropic({
      responses: [{ kind: 'ok', text: '{"ok":true}' }],
    });
    const cc = new ClaudeClient({
      apiKey: 'x',
      model: 'claude-opus-4-7',
      anthropic: client as never,
      sleepFn: async () => {},
    });
    await cc.callJson({
      system: 'hello-system',
      messages: [{ role: 'user', content: 'hi' }],
      cacheControl: true,
    });
    const body = calls[0] as { system: unknown };
    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'hello-system',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('sends system as a plain string when cacheControl is absent', async () => {
    const { client, calls } = makeFakeAnthropic({
      responses: [{ kind: 'ok', text: '{"ok":true}' }],
    });
    const cc = new ClaudeClient({
      apiKey: 'x',
      model: 'claude-opus-4-7',
      anthropic: client as never,
      sleepFn: async () => {},
    });
    await cc.callJson({
      system: 'hello-system',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const body = calls[0] as { system: unknown };
    expect(body.system).toBe('hello-system');
  });
});

describe('ClaudeClient.callJsonWithImage', () => {
  it('attaches the image as a content block on the last user message', async () => {
    const { client, calls } = makeFakeAnthropic({
      responses: [{ kind: 'ok', text: '{"seen":true}' }],
    });
    const cc = new ClaudeClient({
      apiKey: 'x',
      model: 'claude-opus-4-7',
      anthropic: client as never,
      sleepFn: async () => {},
    });
    const result = await cc.callJsonWithImage<{ seen: boolean }>({
      system: 'sys',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ack' },
        { role: 'user', content: 'look at this' },
      ],
      imageBase64: 'AAAA',
      imageMediaType: 'image/png',
    });
    expect(result).toEqual({ seen: true });
    const body = calls[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages.length).toBe(3);
    // earlier messages untouched
    expect(body.messages[0]).toEqual({ role: 'user', content: 'first' });
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'ack' });
    // final user message gets [image, text] content array
    const last = body.messages[2];
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content)).toBe(true);
    const content = last.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(2);
    expect(content[0]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'AAAA',
      },
    });
    expect(content[1]).toEqual({ type: 'text', text: 'look at this' });
  });
});
