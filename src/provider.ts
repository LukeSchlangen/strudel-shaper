/** The interface real models plug into (milestone 4). The model returns code and short labels only. */
export type Mode = 'shape' | 'fix-minimal' | 'fix-rewrite';

export interface OptionRequest {
  mode: Mode;
  buffer: string; // full editor text
  selection: { from: number; to: number; text: string };
  instruction: string; // may be empty
  error?: string; // current eval error, if any
  cps: number;
}

/** `code` replaces the selection only. */
export interface Option {
  id: string;
  label: string;
  code: string;
}

export interface Provider {
  name: string;
  generateOptions(req: OptionRequest, signal: AbortSignal): AsyncIterable<Option>;
}
