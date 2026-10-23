import type { Capture } from './splice';

/**
 * Whether the buffer has nothing to run: it is empty, only whitespace, or only `//` and `/* *\/`
 * comments. That is when "New idea" shows and ⌘K generates instead of shaping. A `//` inside a
 * string can't make code look empty: the string's opening quote is left over.
 */
export function noRunnableCode(text: string): boolean {
  return (
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .trim() === ''
  );
}

/** Generate replaces the whole buffer, comments included: the model reads them as notes. */
export function generateCapture(buffer: string): Capture {
  return { range: { from: 0, to: buffer.length }, text: buffer, buffer };
}
