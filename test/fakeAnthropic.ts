import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesClient } from '../server/providers/claude';

type Event = Anthropic.RawMessageStreamEvent;

/** Stream events for a text response, as the API sends them (one text block, split into deltas). */
export function textEvents(
  text: string,
  { chunk = 7, stop = 'end_turn', usage = { input: 120, output: 80, cacheRead: 3000, cacheWrite: 0 } }: { chunk?: number; stop?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } } = {},
): Event[] {
  const events: any[] = [
    {
      type: 'message_start',
      message: {
        usage: { input_tokens: usage.input, output_tokens: 1, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ];
  for (let i = 0; i < text.length; i += chunk) {
    events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + chunk) } });
  }
  events.push({ type: 'content_block_stop', index: 0 });
  events.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: usage.output } });
  events.push({ type: 'message_stop' });
  return events as Event[];
}

/**
 * A fake `client.messages.create(…, {signal})`. Each call takes the next script (or `throws`).
 * `gate` holds the stream after the given number of events, so tests can abort mid-stream.
 */
export class FakeMessages implements MessagesClient {
  calls: Array<{ params: Anthropic.MessageCreateParamsStreaming; signal?: AbortSignal }> = [];
  aborted = 0;
  constructor(
    private scripts: Array<Event[] | Error | ((params: Anthropic.MessageCreateParamsStreaming) => Event[])>,
    private gate?: { after: number; until: Promise<void> },
  ) {}

  messages = {
    create: async (params: Anthropic.MessageCreateParamsStreaming, options?: { signal?: AbortSignal }) => {
      this.calls.push({ params, signal: options?.signal });
      const script = this.scripts.length > 1 ? this.scripts.shift()! : this.scripts[0];
      if (script instanceof Error) throw script;
      const events = typeof script === 'function' ? script(params) : script;
      const signal = options?.signal;
      const gate = this.gate;
      const self = this;
      return (async function* () {
        for (let i = 0; i < events.length; i++) {
          if (gate && i === gate.after) {
            await Promise.race([gate.until, new Promise((r) => signal?.addEventListener('abort', r, { once: true }))]);
          }
          if (signal?.aborted) {
            self.aborted++;
            throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
          }
          await Promise.resolve();
          yield events[i];
        }
      })();
    },
  };
}
