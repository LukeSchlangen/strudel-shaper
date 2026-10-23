import type { Effort, ThinkingSetting, Usage } from '../../src/remoteProtocol';

/**
 * Per-model settings. Prices are USD per million tokens.
 * Claude prices from https://platform.claude.com/docs/en/about-claude/pricing.
 * Gemini prices from https://ai.google.dev/pricing.
 */
export interface ModelInfo {
  id: string;
  provider: 'claude' | 'gemini';
  prices: { input: number; cacheWrite5m: number; cacheRead: number; output: number };
  thinkingOff?: { type: 'disabled' } | { type: 'between_tools' };
  /** Chosen from the eval sweep (NOTES.md, milestone 4). */
  defaults: { effort: Effort; thinking: ThinkingSetting };
}

export const MODELS: Record<string, ModelInfo> = {
  'claude-haiku-5-5': {
    id: 'claude-haiku-5-5',
    provider: 'claude',
    prices: { input: 0.1, cacheWrite5m: 0.125, cacheRead: 0.01, output: 0.5 },
    thinkingOff: { type: 'disabled' },
    defaults: { effort: 'low', thinking: 'off' },
  },
  'claude-sonnet-5-5': {
    id: 'claude-sonnet-5-5',
    provider: 'claude',
    prices: { input: 2, cacheWrite5m: 2.5, cacheRead: 0.1, output: 10 },
    thinkingOff: { type: 'between_tools' },
    defaults: { effort: 'low', thinking: 'off' },
  },
  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    provider: 'gemini',
    prices: { input: 0.05, cacheWrite5m: 0.0125, cacheRead: 0.0125, output: 0.2 },
    defaults: { effort: 'low', thinking: 'off' },
  },
  'gemini-3.8-flash': {
    id: 'gemini-3.8-flash',
    provider: 'gemini',
    prices: { input: 0.1, cacheWrite5m: 0.025, cacheRead: 0.025, output: 0.4 },
    defaults: { effort: 'low', thinking: 'off' },
  },
  'gemini-4-argon': {
    id: 'gemini-4-argon',
    provider: 'gemini',
    prices: { input: 1.0, cacheWrite5m: 0.25, cacheRead: 0.25, output: 4.0 },
    defaults: { effort: 'low', thinking: 'off' },
  },
};

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/**
 * The model for each mode when the browser doesn't name one (NOTES.md, milestone 5).
 */
export const MODE_DEFAULT_MODELS: Record<string, string> = {
  shape: DEFAULT_MODEL,
  'fix-minimal': 'claude-haiku-5-5',
  'fix-rewrite': 'claude-sonnet-5-5',
};

export const GEMINI_MODE_DEFAULT_MODELS: Record<string, string> = {
  shape: DEFAULT_GEMINI_MODEL,
  'fix-minimal': 'gemini-3.5-flash-lite',
  'fix-rewrite': 'gemini-4-argon',
};

export function defaultModelFor(provider: string, mode: string): string {
  if (provider === 'gemini') {
    return GEMINI_MODE_DEFAULT_MODELS[mode] ?? DEFAULT_GEMINI_MODEL;
  }
  return MODE_DEFAULT_MODELS[mode] ?? DEFAULT_MODEL;
}

export function costUsd(model: ModelInfo, u: Usage): number {
  const p = model.prices;
  return (u.input * p.input + u.cacheWrite * p.cacheWrite5m + u.cacheRead * p.cacheRead + u.output * p.output) / 1e6;
}
