import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFixtures } from '../eval/fixtures';
import { asksForSilence } from '../src/feedback';
import { Sandbox } from '../src/sandbox';

const sounds = new Set(JSON.parse(readFileSync(fileURLToPath(new URL('../src/generated/sounds.json', import.meta.url)), 'utf8')) as string[]);
const fixtures = loadFixtures();

describe('eval fixtures', () => {
  let sandbox: Sandbox;
  beforeAll(async () => {
    sandbox = await Sandbox.create();
  });

  it('has 20 requests over 5 buffers, a few empty instructions and a few asking for silence', () => {
    expect(fixtures).toHaveLength(20);
    expect(new Set(fixtures.map((f) => f.bufferId)).size).toBe(5);
    expect(fixtures.filter((f) => f.instruction === '').length).toBeGreaterThanOrEqual(4);
    expect(fixtures.filter((f) => asksForSilence(f.instruction)).length).toBeGreaterThanOrEqual(2);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(20);
  });

  it.each([...new Set(fixtures.map((f) => f.bufferId))])('buffer "%s" evaluates, sounds, and uses only loaded sounds', async (id) => {
    const { buffer } = fixtures.find((f) => f.bufferId === id)!;
    const r = await sandbox.check(buffer, 0.5);
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (!r.ok) return;
    expect(r.eventCount).toBeGreaterThan(4);
    expect(r.sounds.filter((s) => !sounds.has(s))).toEqual([]);
  });

  it.each(fixtures.map((f) => [f.id, f] as const))('%s: the selection is one expression that evaluates on its own', async (_id, f) => {
    const r = await sandbox.check(f.selection.text, 0.5);
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
  });
});
