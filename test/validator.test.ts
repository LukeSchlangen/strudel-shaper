import { beforeAll, describe, expect, it } from 'vitest';
import type { Option } from '../src/provider';
import { Sandbox, soundKey } from '../src/sandbox';
import { STARTER_CODE } from '../src/options';
import { normalizeCode, VALIDATION_TIMEOUT_MS, Validator } from '../src/validator';

const HH = 's("hh*8").gain(0.6)';
const range = { from: STARTER_CODE.indexOf(HH), to: STARTER_CODE.indexOf(HH) + HH.length };
const KNOWN = new Set(['bd', 'hh', 'oh', 'sawtooth', 'triangle', 'rolandtr909_bd']);
const opt = (code: string, label = 'x'): Option => ({ id: label, label, code });

let validator: Validator;
const validate = (code: string, others: Option[] = []) => validator.validate(STARTER_CODE, range, opt(code), others);

beforeAll(async () => {
  const sandbox = await Sandbox.create();
  validator = new Validator({ backend: sandbox, hasSound: (k) => KNOWN.has(k), cps: () => 0.5 });
});

describe('Validator stages', () => {
  it('accepts a valid option and counts 2 cycles of onsets', async () => {
    const r = await validate('s("hh*8").fast(2)');
    expect(r).toMatchObject({ ok: true, warnings: [] });
    // 4 kicks + 16 hats + 4 bass notes per cycle, ×2 cycles
    expect(r.eventCount).toBe(2 * (4 + 16 + 4));
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('identical: same as the selection after normalizing whitespace', async () => {
    const r = await validate('s( "hh*8" ) .gain( 0.6 )');
    expect(r).toMatchObject({ ok: false, reason: 'identical' });
  });

  it('duplicate: same as an accepted option after normalizing whitespace', async () => {
    const r = await validate('s("hh*8").fast( 2 )', [opt('s("hh*8").rev()', 'a'), opt('s("hh*8").fast(2)', 'double')]);
    expect(r).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(r.message).toContain('double');
  });

  it('identical is checked before syntax', async () => {
    expect((await validate(HH + ' ')).reason).toBe('identical');
  });

  it('syntax: unclosed paren', async () => {
    const r = await validate('s("hh*8").fast(2');
    expect(r).toMatchObject({ ok: false, reason: 'syntax' });
    expect(r.message).toMatch(/Unexpected token/);
  });

  it('syntax: unclosed quote', async () => {
    expect((await validate('s("hh*8).gain(0.6)')).reason).toBe('syntax');
  });

  it('syntax: mini-notation parse error (thrown by the transpiler)', async () => {
    const r = await validate('s("hh*8[").gain(0.6)');
    expect(r.reason).toBe('syntax');
    expect(r.message).toMatch(/\[mini\] parse error/);
  });

  it('eval: invented function', async () => {
    const r = await validate('s("hh*8").wobble(2)');
    expect(r).toMatchObject({ ok: false, reason: 'eval' });
    expect(r.message).toMatch(/wobble is not a function/);
  });

  it('eval: the buffer produces no pattern', async () => {
    const whole = { from: 0, to: STARTER_CODE.length };
    const r = await validator.validate(STARTER_CODE, whole, opt('setcps(1)'), []);
    expect(r).toMatchObject({ ok: false, reason: 'eval' });
    expect(r.message).toMatch(/no pattern/);
  });

  it('query: throws only when queried', async () => {
    const r = await validate('s("hh*8").fmap(v => v.velocity.toFixed(2))');
    expect(r).toMatchObject({ ok: false, reason: 'query' });
    expect(r.message).toMatch(/toFixed/);
  });

  it('empty: 0 onsets is a warning, not a drop', async () => {
    const whole = { from: 0, to: STARTER_CODE.length };
    const r = await validator.validate(STARTER_CODE, whole, opt('s("hh*8").degradeBy(1)'), []);
    expect(r).toMatchObject({ ok: true, warnings: ['empty'], eventCount: 0 });
  });

  it('unknown-sample: names the sounds missing from the supplied list', async () => {
    const r = await validate('s("zzzz*4")');
    expect(r).toMatchObject({ ok: true, warnings: ['unknown-sample'], unknownSounds: ['zzzz'] });
  });

  it('unknown-sample: banks, :n and rests resolve like superdough', async () => {
    expect((await validate('s("bd*2").bank("RolandTR909")')).warnings).toEqual([]);
    expect((await validate('s("bd:3 ~ hh:1 -")')).warnings).toEqual([]);
    const r = await validate('s("bd").bank("nope")');
    expect(r.unknownSounds).toEqual(['nope_bd']);
  });

  it('timeout: an option that takes longer than the limit is dropped', async () => {
    const slow = `s("hh").fmap(v => v).add(0).firstOf(1, x => { const t = Date.now(); while (Date.now() - t < ${VALIDATION_TIMEOUT_MS + 50}); return x })`;
    const r = await validate(slow);
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(r.ms).toBeGreaterThan(VALIDATION_TIMEOUT_MS);
  });
});

describe('soundKey', () => {
  it('follows superdough lookup', () => {
    expect(soundKey({ s: 'BD' })).toBe('bd');
    expect(soundKey({ s: 'bd:3' })).toBe('bd');
    expect(soundKey({ s: 'bd', bank: 'RolandTR909' })).toBe('rolandtr909_bd');
    expect(soundKey({ note: 'c2' })).toBe('triangle');
    expect(soundKey({ s: '~' })).toBeNull();
    expect(soundKey('hh')).toBeNull();
  });
});

describe('normalizeCode', () => {
  it('ignores whitespace outside strings, except between words', () => {
    expect(normalizeCode('s("hh*8") .gain( 0.6 )')).toBe('s("hh*8").gain(0.6)');
    expect(normalizeCode('x => x.fast(2)')).toBe('x=>x.fast(2)');
    expect(normalizeCode('new  Foo')).toBe('new Foo');
    expect(normalizeCode('a,\n  b')).toBe('a,b');
  });

  it('collapses and trims whitespace inside strings, but keeps it', () => {
    expect(normalizeCode('s(" hh   hh ")')).toBe('s("hh hh")');
    expect(normalizeCode('s("hh hh")')).not.toBe(normalizeCode('s("hhhh")'));
    expect(normalizeCode("s('a  b')")).toBe("s('a b')");
  });

  it('handles escapes and the other quote inside a string', () => {
    expect(normalizeCode('"it\'s  x"')).toBe('"it\'s x"');
    expect(normalizeCode('"a \\"  b"')).toBe('"a \\" b"');
  });
});
