import type { RawOption } from '../jsonStream';

export const SEL_OPEN = '/*<sel>*/';
export const SEL_CLOSE = '/*</sel>*/';
export const MAX_OPTIONS = 4;
/** A minimal fix is one option, or two when the intent is genuinely ambiguous. */
export const maxOptionsFor = (mode: string) => (mode === 'fix-minimal' ? 2 : MAX_OPTIONS);
const MAX_LABEL_WORDS = 4;

/**
 * Makes a model's option fit back into the buffer: the code replaces only the selection, which
 * capture already trimmed of surrounding whitespace and a trailing `,`/`;` (they stay in the buffer).
 * Returns null for an option with no code left.
 */
export function cleanOption(raw: RawOption): RawOption | null {
  let code = raw.code.split(SEL_OPEN).join('').split(SEL_CLOSE).join('');
  code = code.trim().replace(/[\s,;]+$/, '').trim();
  if (!code) return null;
  const words = raw.label.trim().split(/\s+/).filter(Boolean);
  const label = words.slice(0, MAX_LABEL_WORDS).join(' ') || 'option';
  return { label, code };
}
