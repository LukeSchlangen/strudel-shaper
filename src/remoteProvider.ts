import { ProviderError, type Option, type OptionRequest, type Provider, type ProviderHooks } from './provider';
import { LineSplitter, type Effort, type RemoteLine, type RemoteRequest, type Strategy, type ThinkingSetting } from './remoteProtocol';

export interface RemoteSettings {
  effort?: Effort;
  thinking?: ThinkingSetting;
  strategy?: Strategy;
}

export interface RemoteProviderOptions {
  provider: string; // the server-side adapter, e.g. "claude"
  model: string;
  endpoint?: string;
  /** The compact sound summary sent with each request (read when the request is made). */
  sounds?: () => string | undefined;
  settings?: () => RemoteSettings;
  fetch?: typeof fetch;
}

/**
 * A model behind the local proxy (server/). Posts the request, reads NDJSON lines and yields each
 * option as its line arrives. Error lines become a ProviderError; stats go to `hooks.onStats`.
 * Nothing here is specific to one model or vendor.
 */
export class RemoteProvider implements Provider {
  readonly name: string;
  private seq = 0;

  constructor(private readonly opts: RemoteProviderOptions) {
    this.name = `${opts.provider} · ${opts.model.replace(/^claude-/, '')}`;
  }

  get model() {
    return this.opts.model;
  }

  async *generateOptions(req: OptionRequest, signal: AbortSignal, hooks?: ProviderHooks): AsyncGenerator<Option> {
    const body: RemoteRequest = {
      ...req,
      provider: this.opts.provider,
      model: this.opts.model,
      sounds: this.opts.sounds?.(),
      ...this.opts.settings?.(),
    };
    const doFetch = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(this.opts.endpoint ?? '/api/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      throw new ProviderError('network', 'Could not reach the model proxy. Is `npm run dev` running?');
    }
    if (!res.body) throw new ProviderError('network', `The proxy answered ${res.status} with no body.`);
    if (!res.ok && !(res.headers.get('content-type') ?? '').includes('ndjson')) {
      const detail = await res.json().catch(() => null);
      throw new ProviderError(detail?.kind ?? 'internal', detail?.message ?? `The proxy answered ${res.status}.`);
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    const split = new LineSplitter();
    const batch = { error: null as ProviderError | null };
    const handle = (raw: string): Option | null => {
      let line: RemoteLine;
      try {
        line = JSON.parse(raw);
      } catch {
        batch.error ??= new ProviderError('internal', 'The proxy sent a line that was not JSON.');
        return null;
      }
      if (line.type === 'option') return { id: `${this.opts.provider}-${++this.seq}`, label: line.label, code: line.code };
      if (line.type === 'done') {
        hooks?.onStats?.({ ...line.timing, tokens: line.usage, costUsd: line.costUsd });
      } else if (line.type === 'error') {
        batch.error ??= new ProviderError(line.kind, line.message);
      }
      return null;
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        const lines = done ? split.flush() : split.push(value);
        for (const raw of lines) {
          const option = handle(raw);
          if (option && !signal.aborted) yield option;
        }
        if (done) break;
      }
    } catch (err) {
      if (signal.aborted) return;
      throw new ProviderError('network', 'The connection to the model proxy dropped.');
    } finally {
      reader.cancel().catch(() => {});
    }
    if (batch.error && !signal.aborted) throw batch.error;
  }
}
