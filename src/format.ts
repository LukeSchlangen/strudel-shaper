/**
 * Format Strudel code with Prettier, loaded on first use (it is big).
 *
 * Prettier would rewrite string quotes, and in Strudel the quote is meaning: "bd sd" is mini-notation
 * and 'bd sd' is one sound named "bd sd". So every string and comment is swapped for a same-length
 * placeholder before formatting and put back afterwards, byte for byte. The placeholder keeps the
 * line-width decisions the same as they would be for the real text.
 */

export const PRINT_WIDTH = 80;

interface Piece {
  text: string;
  /** The placeholder that stands in for it, or null for code. */
  hole: string | null;
}

/** Split into code, strings (all three quote kinds) and comments. */
function scan(code: string): Piece[] {
  const out: Piece[] = [];
  let codeStart = 0;
  let i = 0;
  const hole = (end: number, placeholder: (text: string) => string) => {
    if (i > codeStart) out.push({ text: code.slice(codeStart, i), hole: null });
    const text = code.slice(i, end);
    out.push({ text, hole: placeholder(text) });
    i = codeStart = end;
  };
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      hole(nl < 0 ? code.length : nl, (t) => '//' + 'c'.repeat(t.length - 2));
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      hole(end < 0 ? code.length : end + 2, (t) => `/*${'c'.repeat(Math.max(t.split('\n')[0].length - 4, 0))}*/`);
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      const end = Math.min(j + 1, code.length);
      // Strings are always rewritten to the double-quoted form of the same width, one line.
      hole(end, (t) => '"' + '_'.repeat(Math.max(t.split('\n')[0].length - 2, 0)) + '"');
    } else {
      i++;
    }
  }
  if (codeStart < code.length) out.push({ text: code.slice(codeStart), hole: null });
  return out;
}

export class FormatError extends Error {}

export async function formatCode(code: string): Promise<string> {
  const pieces = scan(code);
  const holes = pieces.filter((p) => p.hole !== null);
  const masked = pieces.map((p) => p.hole ?? p.text).join('');
  const [prettier, babel, estree] = await Promise.all([
    import('prettier/standalone'),
    import('prettier/plugins/babel'),
    import('prettier/plugins/estree'),
  ]);
  let formatted: string;
  try {
    formatted = await prettier.format(masked, {
      parser: 'babel',
      plugins: [babel, estree as any],
      printWidth: PRINT_WIDTH,
      singleQuote: false,
      semi: false,
      trailingComma: 'none',
    });
  } catch (err) {
    const first = String((err as Error).message ?? err).split('\n')[0];
    throw new FormatError(first.replace(/ \(\d+:\d+\)$/, ''));
  }
  // Put the originals back in order. Every placeholder is `"___"` or a comment of `c`s.
  let n = 0;
  const restored = formatted.replace(/"_*"|\/\/c*|\/\*c*\*\//g, (m) => {
    const next = holes[n++];
    return next ? next.text : m;
  });
  if (n !== holes.length) throw new FormatError("couldn't format this safely");
  return restored.replace(/\n+$/, '') + (/\n$/.test(code) ? '\n' : '');
}

/** The cursor's place in the new text: the same number of non-space characters before it. */
export function mapOffset(before: string, offset: number, after: string): number {
  const solid = before.slice(0, offset).replace(/\s/g, '').length;
  let seen = 0;
  for (let i = 0; i < after.length; i++) {
    if (seen === solid) return i;
    if (!/\s/.test(after[i])) seen++;
  }
  return after.length;
}
