import fixtures from './fixtures.json';
import type { Mode } from '../src/provider';

export interface Fixture {
  id: string;
  bufferId: string;
  buffer: string;
  mode: Mode;
  /** An explicit selection. Fix fixtures may have none and give `cursor` instead (⌘J with only a cursor). */
  selection: { from: number; to: number; text: string } | null;
  /** Where the cursor is, for fixtures without a selection. */
  cursor: number;
  instruction: string;
  /** Fix fixtures: what diagnoseFix should find (`ok` for a rewrite of code that runs). */
  expect?: string;
  /** Fix fixtures: the buffer also fails outside the selection. */
  otherError?: boolean;
}

type RawRequest = { id: string; buffer: string; mode?: string; selection?: string; cursor?: string; instruction: string; expect?: string; otherError?: boolean };

/** The eval requests (shape and fix), with each selection or cursor resolved to an offset in its buffer. */
export function loadFixtures(): Fixture[] {
  const buffers = fixtures.buffers as Record<string, string>;
  return (fixtures.requests as RawRequest[]).map((r) => {
    const buffer = buffers[r.buffer];
    if (buffer === undefined) throw new Error(`${r.id}: unknown buffer "${r.buffer}"`);
    const find = (text: string, what: string) => {
      const at = buffer.indexOf(text);
      if (at < 0) throw new Error(`${r.id}: ${what} not found in "${r.buffer}"`);
      if (buffer.indexOf(text, at + 1) >= 0) throw new Error(`${r.id}: ${what} appears twice in "${r.buffer}"`);
      return at;
    };
    const mode = (r.mode ?? 'shape') as Mode;
    let selection: Fixture['selection'] = null;
    let cursor = 0;
    if (r.selection !== undefined) {
      const from = find(r.selection, 'selection');
      selection = { from, to: from + r.selection.length, text: r.selection };
      cursor = from;
    } else if (r.cursor !== undefined && mode !== 'shape') {
      cursor = find(r.cursor, 'cursor');
    } else {
      throw new Error(`${r.id}: needs a selection${mode === 'shape' ? '' : ' or a cursor'}`);
    }
    return { id: r.id, bufferId: r.buffer, buffer, mode, selection, cursor, instruction: r.instruction, expect: r.expect, otherError: r.otherError };
  });
}

export const isFixMode = (mode: Mode) => mode !== 'shape';
