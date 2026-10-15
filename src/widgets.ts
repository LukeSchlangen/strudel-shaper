import { EditorState, StateField, type Extension, type StateEffectType } from '@codemirror/state';
import type { Range } from './splice';

/**
 * Widgets during audition.
 *
 * StrudelMirror's afterEval (`@strudel/codemirror/codemirror.mjs:209-217`) runs after every
 * evaluation, auditions included, and dispatches slider widgets (`setSliderWidgets`) and block
 * widgets (`addWidget`, e.g. `._scope()`) at positions in the *evaluated* code. During an audition
 * that's the spliced option, not the editor text, so widgets after the selection would jump by the
 * option's length difference, and widgets inside the option have no place in the editor at all.
 *
 * We **hold back** those two effects while an audition evaluates (a transaction filter strips them),
 * so the editor keeps the widgets of its own text. Evaluating the original (Esc/0, commit, or the
 * user's own Ctrl+Enter) dispatches them normally and they follow the editor again.
 *
 * Sliders need one more step. A slider's id is `slider_<position in the evaluated code>`
 * (transpiler + `sliderWithID`), and dragging one posts its *editor* id (`slider_<position at the
 * last editor eval>`). During an audition the pattern reads the id at the slider's position in the
 * spliced code, so `sliderIdMap` translates editor ids to audition ids and main.ts mirrors drags.
 */

export interface SliderConfig {
  from: number;
  type?: string;
}

/** An editor slider: the id its widget posts, and where it is now (mapped through edits since). */
export interface EditorSlider {
  id: string;
  from: number;
}

const sliderId = (from: number) => `slider_${from}`;

/**
 * The editor's sliders, from the last `setSliderWidgets` that reached the editor (held-back ones
 * never do), carried through later document changes.
 */
export function editorSliderField(setSliderWidgets: StateEffectType<SliderConfig[]>) {
  return StateField.define<EditorSlider[]>({
    create: () => [],
    update(sliders, tr) {
      let next = tr.docChanged ? sliders.map((s) => ({ ...s, from: tr.changes.mapPos(s.from, 1) })) : sliders;
      for (const e of tr.effects) {
        if (e.is(setSliderWidgets)) next = e.value.filter((w) => (w.type ?? 'slider') === 'slider').map((w) => ({ id: sliderId(w.from), from: w.from }));
      }
      return next;
    },
  });
}

/** Strips the given effects from transactions while `held()` is true. Other content passes through. */
export function holdEffects(types: Array<StateEffectType<any>>, held: () => boolean): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!held() || !tr.effects.some((e) => types.some((t) => e.is(t)))) return tr;
    return {
      changes: tr.changes,
      selection: tr.selection,
      effects: tr.effects.filter((e) => !types.some((t) => e.is(t))),
      scrollIntoView: tr.scrollIntoView,
    };
  });
}

/**
 * Editor slider id → the id the same slider has in the auditioned code (the option spliced into
 * `range`, `delta` = option length − range length). Sliders inside the range are the option's
 * business and have no editor counterpart.
 */
export function sliderIdMap(sliders: EditorSlider[], range: Range, delta: number): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sliders) {
    if (s.from < range.from) map.set(s.id, sliderId(s.from));
    else if (s.from >= range.to) map.set(s.id, sliderId(s.from + delta));
  }
  return map;
}
