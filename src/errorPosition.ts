/**
 * Where an error message says the error is. JS syntax errors (acorn, via the transpiler) end in
 * `(line:col)`; mini-notation errors say `at line N`; runtime errors carry no position (they run as
 * transpiled code through Function()), so a name from "X is not a function / defined" is searched
 * for in the code instead. See src/fixTarget.ts and test/fixTarget.test.ts.
 */

/** Position from the message text alone: `(L:C)`, `at line N`, or a unique `name` from "X is not a function/defined". */
export function locateError(buffer: string, message: string): { pos?: number; line?: number } {
  const lineStart = (n: number) => {
    let pos = 0;
    for (let i = 1; i < n; i++) {
      const nl = buffer.indexOf('\n', pos);
      if (nl < 0) return buffer.length;
      pos = nl + 1;
    }
    return pos;
  };
  const lc = /\((\d+):(\d+)\)\s*$/.exec(message);
  if (lc) {
    const line = Number(lc[1]);
    return { line, pos: Math.min(buffer.length, lineStart(line) + Number(lc[2])) };
  }
  const mini = /\bparse error at line (\d+)/.exec(message);
  if (mini) {
    const line = Number(mini[1]);
    const start = lineStart(line);
    const text = buffer.slice(start).split('\n')[0];
    return { line, pos: start + (text.length - text.trimStart().length) };
  }
  const named = /([\w$.]+)(?:\(\.\.\.\))?(?:\.([\w$]+))? is not (?:a function|defined)/.exec(message);
  if (named) {
    const name = (named[2] ?? named[1]).split('.').at(-1)!;
    const hits = codeOccurrences(buffer, name);
    if (hits.length === 1) return { pos: hits[0], line: buffer.slice(0, hits[0]).split('\n').length };
  }
  return {};
}

/** Offsets of `name` as a whole identifier outside strings and comments. */
export function codeOccurrences(code: string, name: string): number[] {
  const hits: number[] = [];
  const word = /[\w$]/;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    if (code.startsWith(name, i) && !word.test(code[i - 1] ?? '') && !word.test(code[i + name.length] ?? '')) {
      hits.push(i);
      i += name.length - 1;
    }
  }
  return hits;
}
