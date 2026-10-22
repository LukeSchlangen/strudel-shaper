import { ProviderError, type Mode, type Option, type OptionRequest, type Provider, type ProviderHooks } from './provider';
import { LineSplitter, type Effort, type RemoteLine, type RemoteRequestBody, type Strategy, type ThinkingSetting } from './remoteProtocol';

export interface RemoteSettings {
  effort?: Effort;
  thinking?: ThinkingSetting;
  strategy?: Strategy;
}

export interface RemoteProviderOptions {
  provider: string; // the server-side adapter, e.g. "claude"
  model: string;
  /**
   * The model for a mode, when it isn't `model`. `null` leaves it to the proxy's default for that
   * mode (server/providers/models.ts). Unset: `model` for every mode.
   */
  modelFor?: (mode: Mode) => string | null | undefined;
  endpoint?: string;
  /** The compact sound summary sent with each request (read when the request is made). */
  sounds?: () => string | undefined;
  settings?: () => RemoteSettings;
  accessKey?: () => string | undefined;
  fetch?: typeof fetch;
}

/**
 * A model behind the local proxy (server/). Posts the request, reads NDJSON lines and yields each
 * option as its line arrives. Error lines become a ProviderError; stats go to `hooks.onStats`.
 * Nothing here is specific to one model or vendor.
 */
/**
 * `?fixModel=` / `?rewriteModel=` pick the model for ⌘J / ⌘⇧J; shape uses the selected one. Without
 * a parameter a fix mode is left to the proxy's per-mode default (null).
 */
export function modelForMode(params: URLSearchParams, selected: string) {
  return (mode: Mode): string | null => {
    if (mode === 'fix-minimal') return params.get('fixModel') || null;
    if (mode === 'fix-rewrite') return params.get('rewriteModel') || null;
    return selected;
  };
}

export class RemoteProvider implements Provider {
  readonly name: string;
  private seq = 0;

  constructor(private readonly opts: RemoteProviderOptions) {
    this.name = `${opts.provider} · ${opts.model.replace(/^(claude|gemini)-/, '')}`;
  }

  get model() {
    return this.opts.model;
  }

  async *generateOptions(req: OptionRequest, signal: AbortSignal, hooks?: ProviderHooks): AsyncGenerator<Option> {
    const chosen = this.opts.modelFor ? this.opts.modelFor(req.mode) : this.opts.model;
    const body: RemoteRequestBody = {
      ...req,
      provider: this.opts.provider,
      ...(chosen ? { model: chosen } : {}),
      sounds: this.opts.sounds?.()?.slice(0, 16_000),
      ...this.opts.settings?.(),
    };
    const doFetch = this.opts.fetch ?? fetch;
    const key = this.opts.accessKey?.();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers['x-access-key'] = key;
    let res: Response;
    try {
      res = await doFetch(this.opts.endpoint ?? '/api/options', {
        method: 'POST',
        headers,
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
        hooks?.onStats?.({ ...line.timing, tokens: line.usage, costUsd: line.costUsd, ...(line.model ? { model: line.model } : {}) });
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
