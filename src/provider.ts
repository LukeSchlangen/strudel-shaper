/** The interface real models plug into. The model returns code and short labels only. */
export type Mode = 'shape' | 'fix-minimal' | 'fix-rewrite';

export interface OptionRequest {
  mode: Mode;
  buffer: string; // full editor text
  selection: { from: number; to: number; text: string };
  instruction: string; // may be empty
  error?: string; // current eval error, if any
  cps: number;
  /** Set when asking for a replacement for one option that failed validation. */
  feedback?: { previousCode: string; error: string };
}

/** `code` replaces the selection only. */
export interface Option {
  id: string;
  label: string;
  code: string;
}

/** What a provider can report about one call, for the status line and the eval. All optional. */
export interface ProviderStats {
  firstMs?: number; // first option, as measured by the provider (server side for remote ones)
  lastMs?: number;
  totalMs?: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd?: number;
}

export interface ProviderHooks {
  onStats?(stats: ProviderStats): void;
}

/** A provider failure with a short message fit for the status line. `kind` is the provider's own category. */
export class ProviderError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface Provider {
  name: string;
  generateOptions(req: OptionRequest, signal: AbortSignal, hooks?: ProviderHooks): AsyncIterable<Option>;
}
