import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CATEGORIES, VALUES, buildReference, parseDocs } from '../scripts/build-reference';
import { Sandbox } from '../src/sandbox';
import { COMMON_DRUMS, summariseLoaded, summariseSounds } from '../src/soundSummary';
import { soundKey } from '../src/sandbox';

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
const scope = JSON.parse(read('src/generated/scope.json')) as { globals: string[]; methods: string[] };
const sounds = JSON.parse(read('src/generated/sounds.json')) as string[];

describe('build-reference', () => {
  it('the checked-in reference is up to date (run npm run build:reference)', () => {
    expect(read('src/generated/strudel-reference.md')).toBe(buildReference().text);
  });

  it('only lists names the live scope has', () => {
    const live = new Set([...scope.globals, ...scope.methods, 'setcps', 'setcpm']);
    const { missing } = buildReference();
    expect(missing).toEqual([]);
    for (const [, names] of CATEGORIES) for (const n of names) expect(live.has(n), n).toBe(true);
  });

  it('writes signals and silence as values, never calls', () => {
    const { text } = buildReference();
    const listed = new Set(CATEGORIES.flatMap(([, names]) => names));
    for (const v of [...VALUES].filter((v) => listed.has(v))) {
      expect(text, v).toMatch(new RegExp(`^- ${v}[: ]`, 'm'));
      expect(text, v).not.toMatch(new RegExp(`\\b${v}\\(\\)(?!\`)`));
    }
  });

  it('stays within the prompt budget', () => {
    // ~2.1 characters per token for this code-heavy text (measured: npm run count:prompt).
    const { text } = buildReference();
    expect(text.length / 2.1).toBeLessThan(5000);
    expect(text.length / 2.1).toBeGreaterThan(2500);
  });

  it('parses JSDoc by @name, by the declaration below it, and with synonyms', () => {
    const docs = parseDocs(`
/** Speeds it up.
 * @name fast
 * @synonyms density
 * @param {number | Pattern} factor speed up factor
 * @example
 * s("bd").fast(2)
 */
export const { fast, density } = register('fast', f);
/** The ply function repeats each event.
 * @example
 * s("bd").ply(2)
 */
export const ply = register('ply', f);`);
    expect(docs.get('fast')).toMatchObject({ params: ['factor'], synonyms: ['density'], summary: 'Speeds it up', example: 's("bd").fast(2)' });
    expect(docs.get('ply')).toMatchObject({ summary: 'The ply function repeats each event', example: 's("bd").ply(2)' });
  });

  describe('hand-written examples', () => {
    let sandbox: Sandbox;
    beforeAll(async () => {
      sandbox = await Sandbox.create();
    });
    const extras = read('scripts/reference-extras.md');
    const examples = /```js\n([\s\S]*?)```/.exec(extras)![1].trim().split('\n');
    it.each(examples)('%s evaluates, sounds, and uses loaded sounds', async (code) => {
      const r = await sandbox.check(code, 0.5);
      expect(r.ok, r.ok ? '' : r.message).toBe(true);
      if (!r.ok) return;
      expect(r.eventCount).toBeGreaterThan(0);
      const loaded = new Set(sounds);
      expect(r.sounds.filter((s) => !loaded.has(s))).toEqual([]);
    });
  });
});

describe('summariseSounds', () => {
  const summary = summariseSounds(sounds);

  it('names every common drum and stays compact', () => {
    const first = summary.split('\n')[0];
    for (const d of COMMON_DRUMS.filter((d) => sounds.includes(d))) expect(first).toContain(` ${d}`);
    expect(summary.length / 2.1).toBeLessThan(2500);
  });

  it('folds bank aliases into one entry', () => {
    expect(summary).toMatch(/^ {2}rolandtr909: /m);
    expect(summary).not.toMatch(/^ {2}tr909: /m);
    expect(summary).not.toMatch(/ tr909( |$)/m);
  });

  it('leaves every loaded sound findable: by name, in a listed bank, by bank name, or by instrument family', () => {
    const text = summary.toLowerCase();
    const words = new Set(text.split(/[\s:,()"]+/));
    const missing = sounds.filter((s) => {
      const key = soundKey({ s })!;
      if (words.has(key)) return false;
      const [bank, ...rest] = key.split('_');
      if (!rest.length) return true;
      if (bank === 'gm') return !words.has(rest.join('_'));
      // A drum bank (possibly under its longer alias) or an instrument family `bank_*`.
      return ![...words].some((w) => w === `${bank}_*` || (w.endsWith(bank) && /^[a-z0-9]+$/.test(w)));
    });
    expect(missing).toEqual([]);
  });
});

describe('summariseLoaded', () => {
  it('is empty when the buffer loaded nothing', () => {
    expect(summariseLoaded([])).toBe('');
  });

  it('lists names with variant counts and caps the list', () => {
    expect(summariseLoaded([{ name: 'kick', count: 10 }, { name: 'vox' }, { name: 'oh', count: 1 }])).toMatch(/: kick\(10\) vox oh$/);
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `s${i}` }));
    expect(summariseLoaded(many, 2)).toMatch(/: s0 s1 … and 3 more$/);
  });
});
