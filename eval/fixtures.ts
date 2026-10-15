import fixtures from './fixtures.json';

export interface Fixture {
  id: string;
  bufferId: string;
  buffer: string;
  selection: { from: number; to: number; text: string };
  instruction: string;
}

/** The 20 eval requests, with each selection resolved to a range in its buffer. */
export function loadFixtures(): Fixture[] {
  const buffers = fixtures.buffers as Record<string, string>;
  return fixtures.requests.map((r) => {
    const buffer = buffers[r.buffer];
    if (buffer === undefined) throw new Error(`${r.id}: unknown buffer "${r.buffer}"`);
    const from = buffer.indexOf(r.selection);
    if (from < 0) throw new Error(`${r.id}: selection not found in "${r.buffer}"`);
    if (buffer.indexOf(r.selection, from + 1) >= 0) throw new Error(`${r.id}: selection appears twice in "${r.buffer}"`);
    return { id: r.id, bufferId: r.buffer, buffer, selection: { from, to: from + r.selection.length, text: r.selection }, instruction: r.instruction };
  });
}
