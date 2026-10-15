import { describe, expect, it } from 'vitest';
import { OptionStreamParser, type RawOption } from '../server/jsonStream';
import { cleanOption } from '../server/providers/postprocess';

const OPTIONS: RawOption[] = [
  { label: 'offbeats', code: 's("~ hh ~ hh").gain(0.6)' },
  { label: 'braces', code: 's("{bd sd}%4").sometimes(x => x.speed(2))' },
  { label: 'escapes', code: "s(\"hh*8\").gain('0.4 \\\\ \\\"x\\\"')" },
  { label: 'nested', code: 'stack(s("[bd, ~ sd]"), note("<[c e] g>"))' },
];
const PAYLOAD = JSON.stringify({ options: OPTIONS }, null, 1);

function run(chunks: string[]) {
  const p = new OptionStreamParser();
  const out: Array<{ options: RawOption[]; at: number }> = [];
  const errors: string[] = [];
  chunks.forEach((c, i) => {
    const step = p.push(c);
    if (step.options.length) out.push({ options: step.options, at: i });
    errors.push(...step.errors);
  });
  errors.push(...p.end());
  return { options: out.flatMap((o) => o.options), steps: out, errors };
}

describe('OptionStreamParser', () => {
  it('parses a whole payload', () => {
    const { options, errors } = run([PAYLOAD]);
    expect(options).toEqual(OPTIONS);
    expect(errors).toEqual([]);
  });

  it('gives the same result for every split point', () => {
    for (let i = 0; i <= PAYLOAD.length; i++) {
      const { options, errors } = run([PAYLOAD.slice(0, i), PAYLOAD.slice(i)]);
      expect(options, `split at ${i}`).toEqual(OPTIONS);
      expect(errors).toEqual([]);
    }
  });

  it('gives the same result one character at a time, and emits each option when its object closes', () => {
    const chars = [...PAYLOAD];
    const { options, steps } = run(chars);
    expect(options).toEqual(OPTIONS);
    // The first option comes out at its closing brace, long before the payload ends.
    const firstClose = PAYLOAD.indexOf('}');
    expect(steps[0].at).toBe(firstClose);
    expect(steps).toHaveLength(4);
  });

  it('reports a malformed element but keeps the good ones', () => {
    const text = '{"options":[{"label":"a","code":"x"},{"label":"b","code":3},{"label":"c","code":"y","why":"z"},{"label":"d","code":"w"}]}';
    const { options, errors } = run([text]);
    expect(options.map((o) => o.label)).toEqual(['a', 'd']);
    expect(errors).toEqual(['An option was missing its label or code.', 'An option had unexpected fields: why.']);
  });

  it('reports a truncated stream after keeping complete options', () => {
    const { options, errors } = run([PAYLOAD.slice(0, PAYLOAD.indexOf('braces') + 20)]);
    expect(options).toEqual([OPTIONS[0]]);
    expect(errors).toEqual(['The output ended before the JSON was complete.']);
  });

  it('reports chatter before or after the JSON, and no JSON at all', () => {
    expect(run(['Sure! ' + PAYLOAD]).errors).toEqual(['Unexpected text before the JSON.']);
    expect(run([PAYLOAD + ' hope that helps']).errors).toEqual(['Unexpected text after the JSON.']);
    expect(run(['I cannot do that.']).errors).toEqual(['Unexpected text before the JSON.', 'The output contained no JSON object.']);
  });

  it('reports mismatched brackets', () => {
    expect(run(['{"options":[{"label":"a","code":"x"}}]}']).errors[0]).toMatch(/Mismatched/);
  });
});

describe('cleanOption', () => {
  it('strips echoed sentinels, trailing separators and whitespace', () => {
    expect(cleanOption({ label: 'x', code: '/*<sel>*/s("hh*8"),/*</sel>*/' })).toEqual({ label: 'x', code: 's("hh*8")' });
    expect(cleanOption({ label: 'x', code: '  s("hh*8").fast(2);\n' })).toEqual({ label: 'x', code: 's("hh*8").fast(2)' });
  });

  it('clips labels to four words and drops empty code', () => {
    expect(cleanOption({ label: '  a very long label for this ', code: 'x' })!.label).toBe('a very long label');
    expect(cleanOption({ label: '', code: 'x' })!.label).toBe('option');
    expect(cleanOption({ label: 'x', code: ' ,; ' })).toBeNull();
  });
});
