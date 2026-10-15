import { EditorState, StateEffect } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { transpiler } from '@strudel/transpiler';
import { splice } from '../src/splice';
import { editorSliderField, holdEffects, sliderIdMap, type SliderConfig } from '../src/widgets';

// Stand-ins for @strudel/codemirror's setSliderWidgets and addWidget (that module needs a DOM).
const setSliderWidgets = StateEffect.define<SliderConfig[]>();
const addWidget = StateEffect.define<unknown[]>();
const other = StateEffect.define<number>();

const BUFFER = `setcps(0.5)
stack(
  s("bd*4").gain(slider(0.8, 0, 1)),
  s("hh*8").gain(0.6),
  note("c2 eb2").s("sawtooth").lpf(slider(800, 200, 4000))._scope()
)`;
const SEL = 's("hh*8").gain(0.6)';
const RANGE = { from: BUFFER.indexOf(SEL), to: BUFFER.indexOf(SEL) + SEL.length };

/** The widgets the transpiler reports for `code`, as StrudelMirror's afterEval receives them. */
const widgetsOf = (code: string) => transpiler(code, { emitWidgets: true, id: 'test' }).widgets as Array<SliderConfig & { type: string; to: number }>;

describe('holdEffects', () => {
  let held = false;
  const field = editorSliderField(setSliderWidgets);
  const make = () => EditorState.create({ doc: BUFFER, extensions: [field, holdEffects([setSliderWidgets, addWidget], () => held)] });

  it('lets widget effects through when not auditioning', () => {
    held = false;
    const s = make().update({ effects: setSliderWidgets.of(widgetsOf(BUFFER).filter((w) => w.type === 'slider')) }).state;
    expect(s.field(field).map((x) => x.from)).toEqual(widgetsOf(BUFFER).filter((w) => w.type === 'slider').map((w) => w.from));
  });

  it('strips slider and block widget effects while auditioning, and keeps everything else', () => {
    held = false;
    const before = make().update({ effects: setSliderWidgets.of(widgetsOf(BUFFER).filter((w) => w.type === 'slider')) }).state;
    held = true;
    const option = 's("hh*16").gain(slider(0.5))';
    const auditioned = widgetsOf(splice(BUFFER, RANGE, option));
    const tr = before.update({
      effects: [setSliderWidgets.of(auditioned.filter((w) => w.type === 'slider')), addWidget.of(auditioned.filter((w) => w.type !== 'slider')), other.of(7)],
    });
    expect(tr.effects.some((e) => e.is(setSliderWidgets) || e.is(addWidget))).toBe(false);
    expect(tr.effects.filter((e) => e.is(other)).map((e) => e.value)).toEqual([7]);
    // The editor still knows its own sliders, at their editor positions.
    expect(tr.state.field(field)).toEqual(before.field(field));
  });

  it('keeps document changes made in the same transaction', () => {
    held = true;
    const s = make().update({ changes: { from: 0, insert: '// x\n' }, effects: addWidget.of([]) }).state;
    expect(s.doc.toString().startsWith('// x\n')).toBe(true);
  });

  it('carries editor slider positions through edits', () => {
    held = false;
    const s0 = make().update({ effects: setSliderWidgets.of(widgetsOf(BUFFER).filter((w) => w.type === 'slider')) }).state;
    const s1 = s0.update({ changes: { from: 0, insert: '// tempo\n' } }).state;
    const [a0, b0] = s0.field(field);
    const [a1, b1] = s1.field(field);
    expect([a1.id, b1.id]).toEqual([a0.id, b0.id]); // the ids the widgets post don't change
    expect([a1.from, b1.from]).toEqual([a0.from + 9, b0.from + 9]);
  });
});

describe('sliderIdMap', () => {
  it('maps editor slider ids to the ids the auditioned code uses', () => {
    const editor = widgetsOf(BUFFER)
      .filter((w) => w.type === 'slider')
      .map((w) => ({ id: `slider_${w.from}`, from: w.from }));
    const option = 's("hh*16").gain(slider(0.5)).pan(sine)';
    const delta = option.length - SEL.length;
    const map = sliderIdMap(editor, RANGE, delta);
    // The real ids the transpiler gives the spliced code, outside the option.
    const spliced = widgetsOf(splice(BUFFER, RANGE, option))
      .filter((w) => w.type === 'slider' && (w.from < RANGE.from || w.from >= RANGE.from + option.length))
      .map((w) => `slider_${w.from}`);
    expect([...map.values()]).toEqual(spliced);
    // The kick's slider is before the selection: same id. The bass's is after it: shifted.
    expect([...map.entries()][0][0]).toBe([...map.entries()][0][1]);
    expect([...map.entries()][1][1]).not.toBe([...map.entries()][1][0]);
  });

  it('leaves out sliders inside the selection', () => {
    expect(sliderIdMap([{ id: 'slider_5', from: 5 }], { from: 2, to: 9 }, 4).size).toBe(0);
  });
});
