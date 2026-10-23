import { StateEffect, StateField } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view';
import type { InstructionHistory } from './instructionHistory';
import type { Range } from './splice';

/**
 * A single-line instruction input shown as a CodeMirror tooltip just below the captured range,
 * so it follows scrolling. Enter submits (empty is fine), Esc or blur cancels, Up/Down browse history.
 */
export const DEFAULT_PLACEHOLDER = 'instruction · Enter sends (empty ok) · Esc cancels';

export class InstructionBox {
  private readonly setPos = StateEffect.define<number | null>();
  private readonly input = document.createElement('input');
  private onSubmit: ((instruction: string) => void) | null = null;
  /** Called after the box opens or closes. */
  onToggle: (() => void) | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly history: InstructionHistory,
  ) {
    const setPos = this.setPos;
    const dom = document.createElement('div');
    dom.className = 'shaper-instruction';
    this.input.type = 'text';
    this.input.placeholder = DEFAULT_PLACEHOLDER;
    this.input.spellcheck = false;
    dom.append(this.input);
    const tooltip = (pos: number): Tooltip => ({
      pos,
      above: false,
      strictSide: true,
      create: () => ({ dom, mount: () => this.input.focus() }),
    });

    const field = StateField.define<Tooltip | null>({
      create: () => null,
      update(value, tr) {
        for (const e of tr.effects) if (e.is(setPos)) return e.value === null ? null : tooltip(e.value);
        return value && tr.docChanged ? tooltip(tr.changes.mapPos(value.pos)) : value;
      },
      provide: (f) => showTooltip.from(f),
    });
    view.dispatch({ effects: StateEffect.appendConfig.of(field) });

    this.input.addEventListener('keydown', (e) => this.keydown(e));
    // A doc change re-creates the tooltip, detaching the input mid-update (blur fires synchronously,
    // and dispatching then throws). Check after the update, once mount() has refocused it.
    this.input.addEventListener('blur', () =>
      queueMicrotask(() => {
        if (document.activeElement !== this.input) this.close();
      }),
    );
  }

  get isOpen() {
    return this.onSubmit !== null;
  }

  contains(node: EventTarget | null) {
    return node === this.input;
  }

  open(range: Range, onSubmit: (instruction: string) => void, placeholder = DEFAULT_PLACEHOLDER) {
    // Below the selection's last line, lined up with its first non-blank character. An empty
    // range (an empty buffer) gives its own position: below line 1.
    const doc = this.view.state.doc;
    const last = doc.lineAt(range.to);
    const pos = doc.lineAt(range.from).number === last.number ? range.from : last.from + (last.text.length - last.text.trimStart().length);
    this.onSubmit = onSubmit;
    this.input.value = '';
    this.input.placeholder = placeholder;
    this.history.reset();
    this.view.dispatch({ effects: this.setPos.of(pos) });
    this.input.focus(); // already mounted when reopening
    this.onToggle?.();
  }

  close() {
    if (!this.isOpen) return;
    this.onSubmit = null;
    this.view.dispatch({ effects: this.setPos.of(null) });
    this.onToggle?.();
  }

  private keydown(e: KeyboardEvent) {
    // Keep keys away from the tray, the editor and the global shortcuts (those that run in the
    // capture phase have already seen it).
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const submit = this.onSubmit;
      const text = this.input.value;
      this.close();
      submit?.(text);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      this.view.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = e.key === 'ArrowUp' ? this.history.older() : this.history.newer();
      if (next !== undefined) this.input.value = next;
    }
  }
}
