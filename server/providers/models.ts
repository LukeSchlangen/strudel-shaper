import type { Effort, ThinkingSetting, Usage } from '../../src/remoteProtocol';

/**
 * Per-model settings. Prices are USD per million tokens, from
 * https://platform.claude.com/docs/en/about-claude/pricing (Haiku 5.5: prompts up to 100k tokens;
 * ours are about 5k). The lowest thinking setting differs per model
 * (https://platform.claude.com/docs/en/build-with-claude/thinking): Haiku 5.5 accepts
 * `disabled`, Sonnet 5.5 rejects it with a 400 and offers `between_tools` instead. Both only at
 * effort high or below, which is all we allow.
 */
export interface ModelInfo {
  id: string;
  prices: { input: number; cacheWrite5m: number; cacheRead: number; output: number };
  thinkingOff: { type: 'disabled' } | { type: 'between_tools' };
  /** Chosen from the eval sweep (NOTES.md, milestone 4). */
  defaults: { effort: Effort; thinking: ThinkingSetting };
}

export const MODELS: Record<string, ModelInfo> = {
  'claude-haiku-5-5': {
    id: 'claude-haiku-5-5',
    prices: { input: 0.1, cacheWrite5m: 0.125, cacheRead: 0.01, output: 0.5 },
    thinkingOff: { type: 'disabled' },
    defaults: { effort: 'low', thinking: 'off' },
  },
  'claude-sonnet-5-5': {
    id: 'claude-sonnet-5-5',
    prices: { input: 2, cacheWrite5m: 2.5, cacheRead: 0.1, output: 10 },
    thinkingOff: { type: 'between_tools' },
    defaults: { effort: 'low', thinking: 'off' },
  },
};

export const DEFAULT_MODEL = 'claude-haiku-5-5';

/**
 * The model for each mode when the browser doesn't name one (NOTES.md, milestone 5). Minimal fixes:
 * Haiku made the same fixes as Sonnet at ~1/18 of the cost. Rewrites: Sonnet always returned 4
 * working interpretations on the first try; Haiku 2–3, and once none that made sound.
 */
export const MODE_DEFAULT_MODELS: Record<string, string> = {
  shape: DEFAULT_MODEL,
  'fix-minimal': 'claude-haiku-5-5',
  'fix-rewrite': 'claude-sonnet-5-5',
};

export function costUsd(model: ModelInfo, u: Usage): number {
  const p = model.prices;
  return (u.input * p.input + u.cacheWrite * p.cacheWrite5m + u.cacheRead * p.cacheRead + u.output * p.output) / 1e6;
}
