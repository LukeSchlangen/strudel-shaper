import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { ensureSyntaxTree } from '@codemirror/language';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFixtures } from '../eval/fixtures';
import { asksForSilence } from '../src/feedback';
import { diagnoseFix } from '../src/fixTarget';
import { Sandbox } from '../src/sandbox';
import { Validator } from '../src/validator';

const sounds = new Set(JSON.parse(readFileSync(fileURLToPath(new URL('../src/generated/sounds.json', import.meta.url)), 'utf8')) as string[]);
const all = loadFixtures();
const shape = all.filter((f) => f.mode === 'shape');
const fix = all.filter((f) => f.mode !== 'shape');

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.create();
});

describe('eval fixtures: shape', () => {
  it('has 20 requests over 5 buffers, a few empty instructions and a few asking for silence', () => {
    expect(shape).toHaveLength(20);
    expect(new Set(shape.map((f) => f.bufferId)).size).toBe(5);
    expect(shape.filter((f) => f.instruction === '').length).toBeGreaterThanOrEqual(4);
    expect(shape.filter((f) => asksForSilence(f.instruction)).length).toBeGreaterThanOrEqual(2);
    expect(new Set(all.map((f) => f.id)).size).toBe(all.length);
  });

  it.each([...new Set(shape.map((f) => f.bufferId))])('buffer "%s" evaluates, sounds, and uses only loaded sounds', async (id) => {
    const { buffer } = shape.find((f) => f.bufferId === id)!;
    const r = await sandbox.check(buffer, 0.5);
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (!r.ok) return;
    expect(r.eventCount).toBeGreaterThan(4);
    expect(r.sounds.filter((s) => !sounds.has(s))).toEqual([]);
  });

  it.each(shape.map((f) => [f.id, f] as const))('%s: the selection is one expression that evaluates on its own', async (_id, f) => {
    const r = await sandbox.check(f.selection!.text, 0.5);
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
  });
});

describe('eval fixtures: fix', () => {
  it('covers minimal fixes with and without a selection, an error elsewhere, and rewrites with and without an instruction', () => {
    const minimal = fix.filter((f) => f.mode === 'fix-minimal');
    const rewrite = fix.filter((f) => f.mode === 'fix-rewrite');
    expect(minimal.length).toBeGreaterThanOrEqual(10);
    expect(minimal.some((f) => f.selection === null) && minimal.some((f) => f.selection !== null)).toBe(true);
    expect(new Set(minimal.map((f) => f.expect))).toEqual(new Set(['eval', 'syntax', 'query', 'silent']));
    expect(minimal.some((f) => f.otherError)).toBe(true);
    expect(rewrite.length).toBeGreaterThanOrEqual(2);
    expect(rewrite.some((f) => f.instruction) && rewrite.some((f) => !f.instruction)).toBe(true);
  });

  it.each(fix.map((f) => [f.id, f] as const))('%s: diagnoseFix finds it broken in the stated way', async (_id, f) => {
    const validator = new Validator({ backend: sandbox, hasSound: (k) => sounds.has(k), cps: () => 0.5 });
    const state = EditorState.create({ doc: f.buffer, selection: { anchor: f.cursor }, extensions: javascript() });
    ensureSyntaxTree(state, f.buffer.length, 5000);
    const selection = f.selection && { from: f.selection.from, to: f.selection.to };
    const d = await diagnoseFix({ state, selection, validator });
    if (f.expect === 'ok') {
      expect(d.kind).toBe('ok');
      return;
    }
    expect(d.kind).toBe('broken');
    if (d.kind !== 'broken') return;
    expect(d.error.stage).toBe(f.expect);
    expect(!!d.otherErrors).toBe(!!f.otherError);
    if (f.selection) expect(d.range).toEqual({ from: f.selection.from, to: f.selection.to });
  });
});
