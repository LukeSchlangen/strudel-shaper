# Milestone 1 notes: the audition spike

Versions: `@strudel/repl` 1.3.0 (the latest on npm on 2026-10-15), `@strudel/codemirror` 1.3.0, `@strudel/core` 1.2.6. All are pinned exactly.
All paths below are relative to `node_modules/`.

## Strudel APIs used

### Import the unbundled component
- `@strudel/repl/package.json:5` points `module` at `dist/index.mjs`, which is a **2.4 MB self-contained bundle** with its own copies of CodeMirror and `@strudel/core`. If you import `@strudel/repl` normally, any `@codemirror/*` import in our code is a *different instance*. Then `StateEffect.appendConfig`, `EditorView.updateListener` and `isolateHistory` silently fail or throw.
- So `src/main.ts` imports **`@strudel/repl/repl-component.mjs`**, the unbundled source. It pulls `@strudel/codemirror`, `core`, `webaudio` and so on from their own `dist/index.mjs`, which keep `@codemirror/*` and `@strudel/core` external. `package.json` pins `@codemirror/state`/`view`/`commands` at the versions npm already installed, so everything dedupes to one copy (`npm ls @codemirror/state` shows one). `vite.config.ts` also sets `resolve.dedupe`.

### The `<strudel-editor>` element (`@strudel/repl/repl-component.mjs`)
- `:9`: `initAudioOnFirstClick()` runs at import. It resumes the AudioContext on the first `mousedown` anywhere on the document (`superdough/superdough.mjs:307`).
- `:39`: `connectedCallback` creates `this.editor = new StrudelMirror({...})` synchronously, so `host.editor` is ready right after `append()`.
- `:48`: passes the package's own `prebake` (see Samples below).
- `:60`: `this.editor.setCode(this.code)`. We set the starter buffer with `setAttribute('code', …)` before appending.
- Gotcha: the editor's DOM container is inserted as the element's **next sibling**, not inside it.

### StrudelMirror (`@strudel/codemirror/codemirror.mjs`)
| What | Where | Used as |
| --- | --- | --- |
| The CodeMirror `EditorView` | `:227` `this.editor = initEditor(...)` | `mirror.editor` (selection: `view.state.selection.main`, `view.dispatch(...)`) |
| The REPL (`@strudel/core` `repl()`) | `:183` `this.repl = repl({...})` | `mirror.repl.evaluate(code)`: **evaluates arbitrary code without touching the document** |
| The scheduler | via `repl.scheduler` | `mirror.repl.scheduler` (a `Cyclist`) |
| Normal evaluate | `:305` `evaluate()` runs `flash()` then `repl.evaluate(this.code)` | Play button |
| `this.code` mirrors the doc | `:230-234` `onChange` | evaluating the original after an audition |
| Highlight toggle | `:345` `reconfigureExtension(key, value)` | `reconfigureExtension('isPatternHighlightingEnabled', false/true)` |
| Flash | `:329` `flash()` | after commit |

- `afterEval` (`:209-225`) runs after **every** `repl.evaluate`, auditions included. It sets `this.miniLocations`, then dispatches slider widgets (`:214`), block widgets (`:216`) and `updateMiniLocations` (`:217`) using **positions from the evaluated code**. During an audition those positions belong to the spliced code, not the editor text.
- The Drawer (`:175-177`) calls `this.highlight(...)` every animation frame with the active haps.

### Pausing event highlighting (`@strudel/codemirror/highlight.mjs`)
- `:131` `isPatternHighlightingEnabled(on, config)`. Turning it off removes the `miniLocations`/`visibleMiniLocations` state fields entirely, so the per-frame `showMiniLocations` effects and the `setMiniLocations` from `afterEval` do nothing.
- Turning it back on with `config` (StrudelMirror passes itself, `codemirror.mjs:351`) schedules `updateMiniLocations(config.editor, config.miniLocations)` 100 ms later. **We turn it back on only after the original has been re-evaluated**, so `mirror.miniLocations` matches the editor again. The `resumeHighlight` effect runs after `evaluateEditor`.
- We call `reconfigureExtension` directly rather than `updateSettings`, which would persist the setting to localStorage.
- Verified in the browser: 0 outline decorations while auditioning, 4–6 after returning to the original, and they line up with the text.

### `repl.evaluate` (`@strudel/core/repl.mjs`)
- `:222` `evaluate(code, autostart = true, shouldHush = true)`.
- `:284-289`: **errors are caught and not rethrown.** It returns `undefined` and sets `state.evalError`. The previous pattern keeps playing. We detect failure as `result === undefined`.
- `:105-107` `setPattern` leads to `scheduler.setPattern`.

### Scheduler (`@strudel/core/cyclist.mjs`, `zyklus.mjs`)
- `cyclist.mjs:123` `setPattern(pat)` just assigns `this.pattern`. The clock keeps running, and nothing about time or phase is reset.
- `cyclist.mjs:129` `setCps`: returns early if cps is unchanged. Re-running `setcps(0.5)` on every swap does **not** re-anchor the clock.
- `cyclist.mjs:37-77`: each tick queries `[lastEnd, newEnd)` from `this.pattern` and places each onset at `(cycle - num_cycles_at_cps_change)/cps + seconds_at_cps_change + latency`.
- `zyklus.mjs:7,8,22`: tick duration 0.05 s, callback interval 0.1 s, look-ahead `t + 0.1 + 0.1`.

### Commit (`@codemirror/commands`)
- `isolateHistory` (`@codemirror/commands/dist/index.js:199`, honoured at `:237`). `src/commit.ts` sends one transaction with `changes` + `selection` + `isolateHistory.of('full')`. A typing burst just before the commit therefore can't merge into it. `test/commit.test.ts` checks this against a real `EditorState` + `history()`, and it was confirmed in the browser: one ⌘Z restores the original line exactly.
- Note that undo does not re-evaluate. That is normal Strudel behaviour: the committed option keeps playing until you evaluate again.

### Stale guard
- `StateEffect.appendConfig.of(EditorView.updateListener.of(...))` adds a listener to the running editor. Each doc change is passed through `ChangeSet.iterChanges` and into `mapRange()` (`src/splice.ts`).
- An edit before the range shifts it, and later auditions splice into the *current* buffer at the shifted range. An edit inside or overlapping the range marks the options stale and goes back to the original.
- We keep the buffer as it was at capture time (`Capture.buffer`), but we don't audition against it: that would undo any edits the user made elsewhere.

### Samples
- The repl's own `prebake` (`@strudel/repl/prebake.mjs:41` Dirt-Samples, `:44` uzu-drumkit) registers `bd`, `hh` and `oh`. In the browser, `soundMap` held 1650 sounds including all three. **No extra prebake was needed.**

### Keyboard
- Cmd/Ctrl+K is caught on `window` in the **capture phase**. On macOS, CodeMirror's default keymap binds `Ctrl-k` to `deleteToLineEnd` (`@codemirror/commands/dist/index.js:1704`), so without the capture phase that edit would happen too.

## Options

All four given options were checked with the real transpiler and pattern engine in `test/options.test.ts`. Each one evaluates alone and spliced into the starter buffer, and produces `hh`/`oh` onsets. **None needed replacing.**

| # | Label | Code |
| --- | --- | --- |
| 1 | offbeats | `s("~ hh ~ hh ~ hh ~ hh").gain(0.6)` |
| 2 | open accents | `s("[hh*8, ~ oh]").gain(0.6)` |
| 3 | rolls | `s("hh hh hh [hh hh hh] hh hh hh [hh*4]").gain(0.6)` |
| 4 | swung 16ths (mine) | `s("hh*16").gain("[0.6 0.3]*8").swingBy(1/3, 8)` |

Option 4 uses `swingBy` (`@strudel/core/pattern.mjs:2184`) together with alternating gain accents. The test checks that exactly 8 of the 16 onsets per cycle are pushed off the 16th grid.

## Do swaps land immediately or on a cycle boundary?

**Immediately**, apart from the scheduler's look-ahead. A swap replaces `scheduler.pattern`. Events already queried (up to `scheduler.lastEnd`) still play from the old pattern. The new pattern takes over from `lastEnd`, which is usually **150–250 ms after the key press**, at an arbitrary fractional cycle position. Because only onsets are triggered, nothing is cut off or played twice at the seam. A note that started before the seam just plays to its end.

Measured in Chrome (cps 0.5, so 1 cycle = 2 s):

```
key   cycle@press  takes effect at  ms until audible  anchor kept  scheduler running
1     23.2767      23.40            241               yes          true→true
3     23.6447      23.75            211               yes          true→true
0     24.0100      24.10            180               yes          true→true
4     24.3754      24.50            249               yes          true→true
2     24.7407      24.85            213               yes          true→true
...
```

`repl.evaluate` itself takes about 0–5 ms.

**Phase and drift check.** I tapped the scheduler's own queries (only calls carrying `{cyclist:'cyclist'}`, which leaves out the Drawer's highlight queries). Then I pressed `1 3 0 4 2 0 1 3 0 4 0`, 730 ms apart. Across those 11 swaps:
- 17 kick (`bd`) onsets, **every gap exactly 0.500000 s**, with no duplicates and no missing kicks;
- `sawtooth` onsets stayed on the original grid phases {0, .375, .5, .75};
- the scheduler's anchor (`num_cycles_at_cps_change`, `seconds_at_cps_change`) and `cps` never changed, and `started` stayed true.

The grid didn't move, and the clock never stopped or re-anchored.

**Very fast presses.** For keys sent all at once (`0 1 3 0 4` within about 10 ms), every swap fell inside one look-ahead window. All four took effect at the same cycle (8.1), so only the last one was heard, which is the right result. Evaluations go through a queue that drops superseded requests and never runs them out of order.

### How hard would it be to quantize to the next cycle?

Moderate, roughly half a day with tests. It doesn't need Strudel changes:
1. Before evaluating, keep `old = scheduler.pattern`. After `repl.evaluate`, read `next = scheduler.pattern`.
2. Set `scheduler.pattern` to a stitched pattern whose query splits the requested span at `N = ceil(scheduler.lastEnd)`: it reads `old` before `N` and `next` from `N` on. Core exports `Pattern`, `TimeSpan` and `State`, so this is about 20 lines.
3. Things to handle:
   - pressing again before `N` should stitch from the *pending* pattern, not the playing one;
   - `setcps` changes still apply immediately;
   - the Drawer and highlighter see the stitched pattern;
   - waiting up to 2 s at cps 0.5 makes A/B comparison feel slow. Quantizing to the next beat (`ceil(lastEnd*4)/4`) may be the better default.

## Manual listening checklist

Use headphones. Click **▶ Play**, let it run for 2–3 cycles, select `s("hh*8").gain(0.6)`, and press ⌘/Ctrl+K.

- [ ] The starter plays: four kicks per 2 s, steady 8th hats, sawtooth bass. Nothing is silent (that would mean a missing sample).
- [ ] Press `1`: the hats move to offbeats within about ¼ s. The kick and bass don't stumble.
- [ ] Press `3`: rolls. Press `0`: back to straight 8ths. Press `4`: swung, accented 16ths. Each change lands within about ¼ s.
- [ ] Hammer `0 1 3 0 4` as fast as you can, several times. You should hear **no gap, click, double kick, or tempo wobble**. Tap your foot to the kick throughout.
- [ ] Clap along to the kick, then switch options for about 30 s. The kick should still line up with your clapping (no drift).
- [ ] Press `2`: open hats on the offbeat of each half. Check that `oh` sounds different from `hh`.
- [ ] While auditioning, the editor text never changes and no outline boxes flash on the code.
- [ ] Press `Esc`: the original returns and the outline highlights come back, on the right tokens.
- [ ] Press `Esc` again: the tray closes and the original keeps playing.
- [ ] Reopen the tray, press `4` then `Enter`: line 4 now shows option 4, the editor flashes, and the music doesn't hiccup. ⌘Z once restores `s("hh*8").gain(0.6)` exactly. Undo doesn't re-evaluate, which is expected.
- [ ] Reopen the tray, press `1`, then click into the editor and type inside the hi-hat line: the tray turns "stale" and the original (with your edit) plays. `1`–`4` do nothing.
- [ ] Reopen the tray, press `1`, then edit the `bd*4` line. The tray should *not* go stale, and pressing `3` should play your edited kick together with option 3.

## Open problems

- **Widgets during audition.** `afterEval` also places slider and block widgets (`codemirror.mjs:214-216`) using the auditioned code's positions. The starter buffer has none. With `slider()` or `._scope()` in the buffer, widgets would jump or move during audition. Fix: shift the locations back by the splice delta, or hold back the `afterEval` widget dispatch while auditioning.
- **Evaluating from the editor while the tray is open.** Ctrl/Alt+Enter in the editor evaluates the real text but the tray still marks an option as heard. The tray should close or reset on an outside evaluation (listen to the element's `update` event and compare `activeCode`).
- **`repl.state.code` / `isDirty`.** These now track the last *auditioned* code, because `repl.evaluate` calls `updateState({code})`. Nothing reads them yet, but a future "dirty" indicator would be wrong during audition.
- **Audio needs a mouse click.** `initAudioOnFirstClick` listens for `mousedown` only. If you start with Ctrl+Enter before clicking anywhere, the clock runs but you hear nothing. The Play button works around this.
- **Option length vs. the selection.** The options are hard-coded for the hi-hat line. Capturing any other selection replaces it with hi-hat code anyway (fine for the spike).
- **Swap latency is fixed at ~150–250 ms** by Strudel's look-ahead (`zyklus.mjs`). Reducing it means changing scheduler internals.
- **Bundle size.** The build is 1.8 MB, mostly Strudel. `@strudel/soundfonts` triggers a direct-`eval` warning in the build.
