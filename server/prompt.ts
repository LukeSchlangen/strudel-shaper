import type { RemoteRequest } from '../src/remoteProtocol';
import { MAX_OPTIONS, SEL_CLOSE, SEL_OPEN } from './providers/postprocess';

/**
 * The prompt, in cache order: the static role + rules + Strudel reference first (identical for
 * every request, so it's a cache hit after the first), then the sound summary (stable for a page
 * session), then the per-request message (buffer, selection, instruction, feedback).
 */

export const ROLE = `You write Strudel code. Strudel is the JavaScript port of TidalCycles for live-coding music in the browser.

The user has marked part of their buffer with ${SEL_OPEN} and ${SEL_CLOSE}. Each request has a mode: shape, fix-minimal or fix-rewrite (below). You return code for the marked part only, as JSON: {"options":[{"label":"…","code":"…"}]}. You never explain, apologise or chat: the only text you write is labels and code.

Rules for every option, in every mode:
- "code" replaces exactly the text between the markers and must still fit in the buffer around it. Don't include the markers, the code around them, comments, or a trailing comma or semicolon.
- Keep the selection's role and form. If the selection is one pattern inside stack(...), return one pattern expression. If it is a whole statement, return a whole statement.
- Use only functions and methods from the reference below, and only sounds listed as loaded. Unknown names fail.
- Don't change the tempo (no setcps/setcpm) unless the selection already sets it.
- Keep it playable live: no loops, no fetches, no samples() calls, nothing that takes long to compute.
- Keep sliders and visual widgets (slider(...), ._scope(), ._pianoroll()) that are in the selection unless asked to remove them.
- "label" is 1–4 lowercase words.

## Mode: shape

Return variations of working code. The label names the musical idea, e.g. "offbeat ghost notes", "filter sweep", "call and response".

How many: return 3 or 4 options (never more than ${MAX_OPTIONS}), unless the request asks for exactly one.

Make the options musically distinct. Each one takes a different direction, for example:
- rhythm and groove (placement, syncopation, swing, euclidean patterns, rests),
- texture and timbre (sound or bank choice, filters, distortion, envelopes),
- pitch and harmony (notes, scales, chords, octaves, arpeggios), where the selection has pitch,
- structure over time (alternation with <>, every/sometimes/whenmod, variation across cycles),
- space (pan, jux, delay, room).
Options that differ only in a number (gain 0.5 vs 0.6, fast(2) vs fast(3)) are not distinct. Each option must still sound good with the rest of the buffer.

With an empty instruction, offer varied, musically interesting directions. With an instruction, every option follows it, each in a different way. If the instruction asks to remove, mute or drop something, an option may be silent or sparser; otherwise every option must make sound.

## Mode: fix-minimal

The marked code is broken: it fails with the error given, or it runs but makes no sound. The user is learning, and the difference between their code and yours is the only explanation they get, so it must be small and exact.
- Return 1 option. Return 2 only if what the code means is genuinely ambiguous, each fixing it a different way.
- Change as little as possible: fix the error and nothing else. Keep every musical choice: sounds, notes, rhythm, numbers, effects, their order and the formatting. Don't improve, tidy or add anything.
- Values such as silence, sine, saw and rand are not functions: write sine, not sine().
- The fixed code must run and make sound.
- The label names the fix, e.g. "close bracket", "gain not gian", "add quote", "sine is a value".

## Mode: fix-rewrite

The marked code is a sketch of an idea: it may be broken, or work but not do what was meant. Work out what it is reaching for and rewrite it so it works.
- Return 3 or 4 options, each a different interpretation of the intent.
- Restructuring is allowed: other functions, other mini-notation, a different approach. Keep the musical material (sounds, notes, key) where the sketch makes it clear.
- With an instruction, every option follows it. Without one, infer the intent from the sketch and the rest of the buffer.
- Every option must run and make sound.
- The label names the interpretation, e.g. "bass follows chords", "euclid 3 of 8".`;

export function staticSystem(reference: string): string {
  return `${ROLE}\n\n# Strudel reference\n\n${reference.trim()}\n`;
}

/** Used when the browser didn't send a sound summary (e.g. a hand-made request). */
export const FALLBACK_SOUNDS = 'Drums: bd sd hh oh cp rim lt mt ht cr rd cb. Synths: sine sawtooth square triangle.';

export function soundsSystem(sounds?: string): string {
  return `# Loaded sounds\n\nOnly these sound names exist (use them with s("…") or .s("…"); banks with .bank("…")):\n${(sounds?.trim() || FALLBACK_SOUNDS)}\n`;
}

/** Per-option direction hints for the parallel strategy: one request each, so they differ. */
export const DIRECTIONS = [
  'rhythm and groove',
  'texture and timbre',
  'pitch and harmony, or if the selection has no pitch, structure over time',
  'space and movement (pan, delay, room) or structure over time',
];

export function markSelection(buffer: string, from: number, to: number): string {
  return buffer.slice(0, from) + SEL_OPEN + buffer.slice(from, to) + SEL_CLOSE + buffer.slice(to);
}

export interface UserMessageOptions {
  /** Ask for exactly one option (retries, the parallel strategy). */
  single?: boolean;
  direction?: string;
}

export function userMessage(req: RemoteRequest, opts: UserMessageOptions = {}): string {
  const { from, to } = req.selection;
  const mode = req.mode ?? 'shape';
  const lines: string[] = [
    `Mode: ${mode}`,
    `Tempo: ${req.cps} cycles per second.`,
    '',
    'Buffer (the selection is marked):',
    '```js',
    markSelection(req.buffer, from, to),
    '```',
  ];
  const instruction = req.instruction.trim();
  if (mode === 'shape') {
    lines.push('', instruction ? `Instruction: ${instruction}` : 'Instruction: none. Offer varied, musically interesting directions.');
    if (req.error) lines.push('', `The buffer currently fails to evaluate with: ${req.error}`);
  } else {
    if (mode === 'fix-rewrite') {
      lines.push('', instruction ? `Instruction: ${instruction}` : 'Instruction: none. Infer what the sketch is reaching for.');
    }
    lines.push('', ...errorLines(req));
  }
  if (req.feedback) {
    lines.push(
      '',
      'A previous option for this selection was rejected:',
      '```js',
      req.feedback.previousCode,
      '```',
      req.feedback.error,
    );
  }
  if (opts.direction) lines.push('', `Direction for this option: ${opts.direction}.`);
  if (opts.single || req.feedback) lines.push('', 'Return exactly one option.');
  return lines.join('\n');
}

/** Fix modes: the error, where it is relative to the selection, and any other error in the buffer. */
function errorLines(req: RemoteRequest): string[] {
  if (!req.error) return ['The marked code runs. Rewrite it as asked.'];
  const at = req.errorAt;
  const selLine = req.buffer.slice(0, req.selection.from).split('\n').length;
  const selLines = req.selection.text.split('\n').length;
  const where = (line?: number) => {
    if (!line) return '';
    const inside = line >= selLine && line < selLine + selLines;
    return inside && selLines > 1 ? ` (buffer line ${line}, line ${line - selLine + 1} of the marked code)` : ` (buffer line ${line})`;
  };
  const out: string[] = [];
  if (!at || at.inSelection) {
    out.push(`Problem in the marked code: ${req.error}${where(at?.line)}`);
  } else {
    out.push(`The buffer fails outside the marked code, with: ${req.error}${where(at.line)}. Don't try to fix that; it isn't yours to change.`);
  }
  if (at?.otherError) {
    out.push(`The buffer also fails elsewhere, outside the marked code: ${at.otherError.message}${where(at.otherError.line)}. Leave that alone; fix only the marked code.`);
  }
  return out;
}

/**
 * The structured-output schema. `maxItems` isn't supported and `minItems` only takes 0 or 1
 * (https://platform.claude.com/docs/en/build-with-claude/structured-outputs), so the count lives in
 * the prompt and the server keeps at most four. `key` exists only to measure a cold grammar compile.
 */
export function optionSchema(key = 'options') {
  return {
    type: 'object',
    properties: {
      [key]: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '1–4 lowercase words naming the musical idea or the fix' },
            code: { type: 'string', description: 'Strudel code that replaces only the marked selection' },
          },
          required: ['label', 'code'],
          additionalProperties: false,
        },
      },
    },
    required: [key],
    additionalProperties: false,
  };
}
