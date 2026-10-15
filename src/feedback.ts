import type { DropReason, Warning } from './validator';

/** Why a slot was retried or dropped: a hard failure, or a playable option that makes no (known) sound. */
export type RetryReason = DropReason | Warning;

/**
 * Words that ask for silence or less: with one of these in the instruction, an empty option may be
 * exactly what was asked for, so it isn't retried. Whole words with their inflections, so "cut"
 * and "cuts" match but "cutoff" (a filter term) doesn't, and "out" matches but "output" doesn't.
 */
export const SILENCE_WORDS = ['drop', 'mute', 'silence', 'silent', 'remove', 'stop', 'cut', 'out'] as const;

function inflections(word: string): string[] {
  const forms = [word, `${word}s`, `${word}d`, `${word}ed`, `${word}ing`];
  if (word.endsWith('e')) forms.push(`${word.slice(0, -1)}ing`);
  if (/[^aeiou][aeiou][bcdfgklmnprstvz]$/.test(word)) forms.push(`${word}${word.at(-1)}ed`, `${word}${word.at(-1)}ing`);
  return forms;
}

const SILENCE_FORMS = new Set(SILENCE_WORDS.flatMap(inflections));

export function asksForSilence(instruction: string): boolean {
  return instruction
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((w) => SILENCE_FORMS.has(w));
}

/** Plain-words names for the status line and cards. `eval` errors that are unknown functions get their own. */
export function reasonLabel(reason: RetryReason, message = ''): string {
  if (reason === 'eval' && /is not (a function|defined)/.test(message)) return 'unknown function';
  return {
    syntax: 'syntax',
    eval: 'eval error',
    query: 'query error',
    timeout: 'timeout',
    identical: 'identical',
    duplicate: 'duplicate',
    buffer: 'buffer error',
    empty: 'no sound',
    'unknown-sample': 'unknown sample',
  }[reason];
}

export interface FeedbackContext {
  message?: string;
  /** The slot of the accepted option a duplicate matches. */
  twinSlot?: number;
  unknownSounds?: string[];
  /** A few loaded sound names to suggest, e.g. "bd sd hh oh cp". */
  soundHint?: string;
}

/**
 * The retry message, written as an instruction to the model (it goes into the replacement request
 * as `feedback.error`). The validator's own text is quoted where it helps, never pasted as a log line.
 */
export function feedbackFor(reason: RetryReason, ctx: FeedbackContext = {}): string {
  const msg = (ctx.message ?? '').replace(/\s+/g, ' ').trim();
  switch (reason) {
    case 'identical':
      return 'This option is the same as the original selection. Suggest a different variation.';
    case 'duplicate':
      return `This option is the same as option ${ctx.twinSlot ?? 'another'}. Suggest a different variation.`;
    case 'syntax':
      return `This code has a syntax error (${msg}). Return valid Strudel code: check brackets, quotes and mini-notation.`;
    case 'eval': {
      const name = /([\w$.]+) is not (?:a function|defined)/.exec(msg)?.[1];
      if (name) {
        const fn = name.split('.').at(-1);
        return `\`${fn}\` is not a Strudel function here. Use only functions from the reference.`;
      }
      return `This code fails when it runs (${msg}). Return code that evaluates.`;
    }
    case 'query':
      return `This code evaluates but fails while playing (${msg}). Return code that plays, without reading event values that may not exist.`;
    case 'timeout':
      return 'This code takes too long to compute. Return something lighter: no huge fast() factors or deep nesting.';
    case 'buffer':
      return 'The buffer around the selection fails on its own. Return an option that works by itself.';
    case 'empty':
      return 'This option produces no sound. Return a variation that still plays.';
    case 'unknown-sample': {
      const names = (ctx.unknownSounds ?? []).map((s) => `\`${s}\``).join(', ') || 'A sound in it';
      const verb = (ctx.unknownSounds?.length ?? 0) > 1 ? 'are not loaded sounds' : 'is not a loaded sound';
      return `${names} ${verb}. Use only loaded sounds${ctx.soundHint ? `, for example: ${ctx.soundHint}` : ''}.`;
    }
  }
}
