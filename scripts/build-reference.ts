/**
 * Builds src/generated/strudel-reference.md, the Strudel reference in the model's system prompt.
 *
 *   npm run build:reference
 *
 * Inputs: the JSDoc in the installed Strudel packages (node_modules/@strudel/*), the live scope
 * dumped from the page (src/generated/scope.json, from `await __shaper.saveScope()`), a curated
 * list of names (CATEGORIES below) and hand-written notes (scripts/reference-extras.md).
 * Every listed name must exist in the live scope, so the model is never told about a function the
 * live repl would reject. test/reference.test.ts checks that the checked-in file is up to date.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

export const SOURCES = [
  ...['pattern', 'signal', 'controls', 'euclid', 'pick', 'repl'].map((f) => `node_modules/@strudel/core/${f}.mjs`),
  'node_modules/@strudel/tonal/tonal.mjs',
  'node_modules/@strudel/tonal/voicings.mjs',
  'node_modules/@strudel/codemirror/slider.mjs',
  'node_modules/@strudel/webaudio/scope.mjs',
  'node_modules/@strudel/draw/pianoroll.mjs',
];

/** Installed by the repl itself (repl.mjs), so they're not in strudelScope, but live code can call them. */
const REPL_NAMES = new Set(['setcps', 'setcpm']);

/** Names whose JSDoc is missing or not attached where the parser looks. Written by hand, checked by the test. */
const MANUAL: Record<string, string> = {
  silence: '- silence: A pattern with no events. A value, not a function: `stack(s("bd*4"), silence)`, never `silence()`',
  struct: '- struct(binary): Applies a rhythm of `x`/`~` (or 1/0) to the pattern — `note("c3 eb3").struct("x ~ x x")`',
  mask: '- mask(binary): Silences the pattern where the mask is `0`/`~` — `s("hh*8").mask("<1 [0 1]>")`',
  every: '- every(n, func): Applies `func` every n cycles (from the first) — `s("bd sd").every(4, x => x.fast(2))`',
  euclidRot: '- euclidRot(pulses, steps, rotation): Euclidean rhythm, rotated — `s("hh").euclidRot(3, 8, 2)`',
  set: '- set(pat): Merges the values of `pat` into each event — `s("bd*4").set(n("<0 1>"))`',
  nudge: '- nudge(seconds): Shifts the sound in time by seconds, without changing the pattern — `s("hh*8").nudge(".01 0")`',
  delaytime: '- delaytime(seconds) [also delayt, dt]: Time between delay echoes — `s("cp").delay(.5).delaytime(1/8)`',
  setcps: '- setcps(cps) / setcpm(cpm): Sets the tempo in cycles per second / per minute. Only at the top of the buffer.',
  setcpm: '',
  _scope: '- ._scope() / ._pianoroll(): Draw an oscilloscope / piano roll under the line. Visual only.',
  _pianoroll: '',
};

export const CATEGORIES: Array<[string, string[]]> = [
  ['Sources and combining', ['s', 'note', 'n', 'stack', 'cat', 'arrange', 'silence', 'run', 'pick', 'layer', 'superimpose']],
  ['Signals (continuous 0–1 values, not functions: sine.range(200, 800), rand.segment(8))', ['sine', 'saw', 'square', 'tri', 'rand', 'perlin', 'choose', 'wchoose', 'range', 'segment']],
  ['Time', ['fast', 'slow', 'ply', 'off', 'rev', 'iter', 'linger', 'chunk', 'inside', 'swingBy', 'swing', 'press']],
  ['Structure and rhythm', ['struct', 'mask', 'euclid', 'euclidRot', 'legato', 'add', 'sub', 'mul']],
  ['Variation over cycles', ['every', 'firstOf', 'lastOf', 'when', 'sometimes', 'sometimesBy', 'often', 'rarely', 'degrade', 'degradeBy', 'scramble', 'shuffle']],
  ['Layering and space', ['jux', 'juxBy', 'echo', 'echoWith', 'pan']],
  ['Samples', ['bank', 'speed', 'cut', 'chop', 'slice', 'loopAt']],
  ['Level, filters and effects', ['gain', 'lpf', 'lpq', 'hpf', 'hpq', 'bpf', 'vowel', 'crush', 'coarse', 'shape', 'distort', 'room', 'delay', 'delaytime', 'delayfeedback']],
  ['Envelope and synthesis', ['adsr', 'vib', 'detune']],
  ['Pitch and harmony', ['scale', 'scaleTranspose', 'voicing', 'chord', 'rootNotes', 'arp']],
  ['Tempo, sliders and visuals', ['setcps', 'setcpm', 'slider', '_scope', '_pianoroll']],
];

interface Doc {
  name: string;
  params: string[];
  synonyms: string[];
  summary: string;
  example?: string;
}

/** Every JSDoc block in `source`, keyed by @name, or by the name declared on the line after it. */
export function parseDocs(source: string): Map<string, Doc> {
  const docs = new Map<string, Doc>();
  const re = /\/\*\*([\s\S]*?)\*\/\s*([^\n]*)/g;
  for (const [, body, next] of source.matchAll(re)) {
    const lines = body.split('\n').map((l) => l.replace(/^\s*\* ?/, ''));
    const tag = (t: string) => lines.filter((l) => l.startsWith(`@${t}`)).map((l) => l.slice(t.length + 1).trim());
    const declared =
      /register\w*\(\s*\[?\s*['"]([\w$]+)/.exec(next)?.[1] ??
      /export (?:const|let|function|async function) \{?\s*([\w$]+)/.exec(next)?.[1];
    const name = tag('name')[0] ?? declared;
    if (!name) continue;
    const exampleAt = lines.findIndex((l) => l.startsWith('@example'));
    const example = exampleAt >= 0 ? usableExample(lines.slice(exampleAt + 1), name) : undefined;
    const text = lines
      .slice(0, lines.findIndex((l) => l.startsWith('@')) >>> 0)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links
      .replace(/\*+([^*]+)\*+/g, '$1') // emphasis
      .replace(/^Experimental /, '')
      .replace(/\s+/g, ' ')
      .trim();
    const params = tag('param').map((p) => /^(?:\{[^}]*\}\s*)?\[?([\w$.]+)/.exec(p)?.[1] ?? p.split(' ')[0]);
    const synonyms = tag('synonyms').flatMap((s) => s.split(/[\s,]+/).filter(Boolean));
    const doc: Doc = { name, params, synonyms, summary: firstSentence(text), example };
    if (!docs.has(name) || (!docs.get(name)!.summary && doc.summary)) docs.set(name, doc);
  }
  return docs;
}

/** The example's first line, if it is one complete line of code that uses the function. */
function usableExample(lines: string[], name: string): string | undefined {
  const first = lines.find((l) => l.trim() && !l.startsWith('@'))?.trim();
  if (!first || first.startsWith('//') || /[(,[{]$/.test(first) || !first.includes(name)) return undefined;
  const code = first.replace(/\s*\/\/.*$/, '');
  return code.length <= 56 ? code : undefined;
}

/** The first sentence, ending at a full stop followed by a capital (so "0 .. 1" doesn't end it). */
function firstSentence(text: string): string {
  const m = /^(.+?[.!?])\s+(?=[A-Z])/.exec(text);
  const s = (m ? m[1] : text).replace(/[.:]$/, '');
  return s.length > 64 ? s.slice(0, 61).trimEnd() + '…' : s;
}

/**
 * Examples cost ~15 tokens each, so only functions whose call shape isn't obvious from the
 * signature get one (callbacks, chord/scale strings, signals). The extras have whole examples.
 */
const WITH_EXAMPLE = new Set(['pick', 'segment', 'off', 'chunk', 'inside', 'swingBy', 'every', 'firstOf', 'lastOf', 'when', 'sometimesBy', 'jux', 'echoWith', 'superimpose', 'layer', 'euclid', 'struct', 'mask', 'scale', 'voicing', 'chord', 'arp', 'rootNotes', 'chop', 'slice', 'linger', 'ply', 'range']);

/** Patterns exported as values, not functions: `sine.range(…)`, never `sine()` (that throws). */
export const VALUES = new Set(['sine', 'cosine', 'saw', 'square', 'tri', 'rand', 'perlin', 'silence']);

function entry(name: string, doc: Doc | undefined): string {
  const sig = VALUES.has(name) ? name : `${name}(${doc?.params.join(', ') ?? ''})`;
  const summary = doc?.summary ? `: ${doc.summary}` : '';
  const ex = doc?.example && WITH_EXAMPLE.has(name) ? ` — \`${doc.example}\`` : '';
  return `- ${sig}${summary}${ex}`;
}

export function buildReference(read: (path: string) => string = (p) => readFileSync(root(p), 'utf8')) {
  const scope = JSON.parse(read('src/generated/scope.json')) as { globals: string[]; methods: string[] };
  const live = new Set([...scope.globals, ...scope.methods, ...REPL_NAMES]);
  const docs = new Map<string, Doc>();
  for (const file of SOURCES) for (const [k, v] of parseDocs(read(file))) if (!docs.has(k)) docs.set(k, v);
  // Synonyms point back at their main doc (`cutoff` → lpf's doc).
  for (const d of [...docs.values()]) for (const s of d.synonyms) if (!docs.has(s)) docs.set(s, d);

  const missing: string[] = [];
  const undocumented: string[] = [];
  const out: string[] = [
    '<!-- Generated by scripts/build-reference.ts from the installed Strudel packages. Do not edit. -->',
    'Names below exist in this Strudel build. Functions are also methods: `s("bd").fast(2)` is the same as `fast(2, s("bd"))`. Most arguments accept a value or a mini-notation string, which patterns them (`.lpf("<400 2000>")`).',
  ];
  for (const [title, names] of CATEGORIES) {
    out.push('', `## ${title}`);
    for (const name of names) {
      if (!live.has(name)) {
        missing.push(name);
        continue;
      }
      if (name in MANUAL) {
        if (MANUAL[name]) out.push(MANUAL[name]);
        continue;
      }
      const doc = docs.get(name);
      if (!doc) undocumented.push(name);
      out.push(entry(name, doc));
    }
  }
  out.push('', read('scripts/reference-extras.md').trim(), '');
  return { text: out.join('\n'), missing, undocumented };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { text, missing, undocumented } = buildReference();
  writeFileSync(root('src/generated/strudel-reference.md'), text);
  // Code-heavy text tokenizes at roughly 2.1 characters per token (measured with `npm run count:prompt`).
  console.log(`wrote src/generated/strudel-reference.md: ${text.length} chars, ~${Math.round(text.length / 2.1)} tokens`);
  if (missing.length) console.warn(`left out (not in the live scope): ${missing.join(' ')}`);
  if (undocumented.length) console.warn(`no JSDoc found (listed by name only): ${undocumented.join(' ')}`);
}
