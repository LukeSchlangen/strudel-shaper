import type { OptionRequest } from './provider';

/**
 * The wire format between the browser (RemoteProvider) and the proxy (server/), also used by the
 * eval harness. Provider-neutral: a model adapter only has to produce these lines.
 */

export type Effort = 'low' | 'medium' | 'high';
/** `off` asks the adapter for its model's lowest thinking setting; `adaptive` leaves the model's default. */
export type ThinkingSetting = 'off' | 'adaptive';
/** `single`: one request for the whole set. `parallel`: one request per option, run concurrently. */
export type Strategy = 'single' | 'parallel';

export interface RemoteRequest extends OptionRequest {
  provider: string;
  model: string;
  /** Compact summary of the loaded sound names (src/soundSummary.ts). */
  sounds?: string;
  effort?: Effort;
  thinking?: ThinkingSetting;
  strategy?: Strategy;
}

export interface Usage {
  input: number; // uncached input tokens
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'local-rate-limit'
  | 'overloaded'
  | 'refusal'
  | 'truncated'
  | 'bad-request'
  | 'network'
  | 'internal';

export type RemoteLine =
  | { type: 'option'; label: string; code: string }
  | { type: 'done'; timing: { firstMs?: number; lastMs?: number; totalMs: number }; usage: Usage; costUsd: number }
  | { type: 'error'; kind: ErrorKind; message: string };

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** Splits a byte stream into complete NDJSON lines. Feed chunks; a trailing partial line waits for more. */
export class LineSplitter {
  private rest = '';
  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split('\n');
    this.rest = parts.pop()!;
    return parts.filter((l) => l.trim() !== '');
  }
  /** Whatever is left once the stream ends (a last line without a newline). */
  flush(): string[] {
    const last = this.rest.trim();
    this.rest = '';
    return last ? [last] : [];
  }
}
