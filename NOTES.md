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
- ~~**Evaluating from the editor while the tray is open.**~~ Fixed in milestone 2 (see below).
- **`repl.state.code` / `isDirty`.** These now track the last *auditioned* code, because `repl.evaluate` calls `updateState({code})`. Nothing reads them yet, but a future "dirty" indicator would be wrong during audition. Left as is in milestone 2, with a comment in `evaluateCode` (`src/main.ts`).
- ~~**Audio needs a mouse click.**~~ Fixed in milestone 2 (see below).
- ~~**Option length vs. the selection.**~~ Replaced by the mock provider in milestone 2.
- **Swap latency is fixed at ~150–250 ms** by Strudel's look-ahead (`zyklus.mjs`). Reducing it means changing scheduler internals.
- **Bundle size.** The build is 1.8 MB, mostly Strudel. `@strudel/soundfonts` triggers a direct-`eval` warning in the build.

---

# Milestone 2 notes: tray, keyboard, mock provider

Everything below was checked in Chrome on macOS against `npm run dev`, with keys sent through the Claude in Chrome extension (DevTools-protocol key events). `npm test` (92 tests) and `npm run build` pass, and `npm ls` still shows one copy each of `@codemirror/state`, `@codemirror/language` and `@strudel/core`.

## Where things live

| File | What |
| --- | --- |
| `src/provider.ts` | `Mode`, `OptionRequest`, `Option`, `Provider`, exactly as in the brief |
| `src/mockProvider.ts` | Seeded `MockProvider` |
| `src/capture.ts` | What ⌘K / ⌘J operate on |
| `src/instructionBox.ts`, `src/instructionHistory.ts` | The instruction input and its in-memory history |
| `src/diff.ts` | Word-diff segments for the cards (`diff@9.0.0`, `diffWordsWithSpace`) |
| `src/trayMachine.ts` | The tray state machine, now with streaming slots, request ids, regenerate and outside-eval reset |
| `src/quantize.ts` | `nextBoundary`, `stitch`, `Quantizer` |
| `src/main.ts` | Wiring, rendering, keys, and `__shaper.measure()` |

## Mock provider

- Shape mode streams 4 distinct options. Each appends one transform to the selection. All 7 were confirmed in `node_modules/@strudel/core`: `fast` (`pattern.mjs:1925`), `slow` (`:1958`), `ply` (`:1905`), `off` (`:2236`), `rev` (`:2259`), `jux` (`:2379`), and `degradeBy` (`signal.mjs:699`). `test/mockProvider.test.ts` evaluates every transform on the kick, hi-hat and bass expressions, spliced into the starter buffer, with the real transpiler.
- Keyword bias: `sparser|calmer|sparse|calm|less` → degradeBy/slow first; `busier|denser|busy|dense` → fast/ply/off first. Sparser is checked first, so "less busy" reads as sparser. Any other instruction, or none, gives a seeded shuffle.
- The seed is `seed + requestCount`, so R (regenerate) gives a new set and tests stay deterministic. Each option waits a seeded 300–1200 ms; tests use 0.
- Fix modes return one option, the selection unchanged, labelled "mock fix". (**Milestone 3:** now the selection + `.fast(1)`, "mock fix (no-op)", because an unchanged option is dropped as identical.)
- The transform goes **before** any trailing whitespace, `,` or `;` in the selection. A whole-line selection used to produce `s("hh*8").gain(0.6),.fast(2)`, a syntax error (reported by the user, fixed in `d7cfdfa`).
- Abort: the sleep resolves early on abort and the generator returns without yielding again.

## Capture and instruction box

- **With a selection**, the selection is used, minus surrounding whitespace and a trailing `,`/`;`. Those stay in the buffer.
- **With no selection**, the syntax tree was easy to use (`syntaxTree` from `@codemirror/language`; StrudelMirror already loads `javascript()`). Capture takes the largest `CallExpression` (or any expression covering the whole line) that fits entirely on the cursor's line, preferring the one under the cursor, and looks inside `a, b` sequences. On the starter this gives `s("bd*4")`, `s("hh*8").gain(0.6)`, the whole `note(...)...lpf(800)` chain, and `setcps(0.5)`. On the `stack(` line nothing fits, so it **falls back to the trimmed line without its trailing comma** (`stack(`), which options can't usefully change.
- The instruction box is a CodeMirror tooltip (`showTooltip` + a `StateField`) just below the captured range, so it follows scrolling. Enter submits (empty is fine), Esc or blur cancels and refocuses the editor, Up/Down cycle the last 10 instructions (memory only, deduped).
- On submit, the range is checked again (`isRangeIntact`). If the text changed while the box was open, nothing is sent.

## Keyboard

| Action | Key | Result in Chrome on macOS |
| --- | --- | --- |
| Shape selection | ⌘/Ctrl+K | ✅ opens the box; capture phase, so CodeMirror's Ctrl-K `deleteToLineEnd` never runs |
| Minimal fix | ⌘/Ctrl+J | ✅ opens the tray straight away (no instruction box), mode `fix-minimal` |
| Intent rewrite | ⌘/Ctrl+⇧J | ✅ opens the tray straight away, mode `fix-rewrite` (**milestone 3:** now opens the instruction box first) |
| Audition | 1–4 (tray focused) / ⌥1–4 (anywhere) | ✅ ⌥ uses `e.code` (`Digit2`), since macOS ⌥2 types "™". Confirmed nothing is typed into the editor |
| Back to original | 0 or Esc (⌥0 too) | ✅ Esc also works from the editor while the tray is open, unless an autocomplete popup is showing. A second Esc closes |
| Commit heard option | Enter (tray focused) | ✅ |
| Regenerate | R (tray focused) | ✅ aborts the request in flight (`[shaper] request aborted` in the console) |
| Toggle swap timing | T (tray focused) / ⌥T (anywhere) | ✅ cycles immediate → beat → cycle; shown in the header and the tray status line |

- Tray keys are ignored when ⌘, Ctrl or ⌥ is held, so ⌘R still reloads.
- Plain digits typed in the editor still type digits (checked: `)` → `)1`).
- **No shortcut changes were needed.** **Caveat:** the test keys were sent through the DevTools protocol, which goes straight to the page and may not pass through Chrome's own menu shortcuts. A physical ⌘J / ⌘⇧J still needs a quick hand check. If Chrome takes either one, the fallback is ⌘; / ⌘⇧; (change the `KeyJ` checks in `main.ts`).

## Option tray

- Card 0 is the original. Cards 1–4 start as dashed "waiting for option" placeholders and fill in arrival order.
- Each card shows its label and a word diff against the selection (`<ins>` green, `<del>` red strikethrough, monospace). Code gets a line-break opportunity before each `.method`, so narrow cards wrap at calls instead of mid-token.
- When the provider finishes with fewer options, the leftover placeholders become "no option".
- A card whose `repl.evaluate` returns `undefined` is marked "(failed)" and can't be auditioned again. The original comes back.
- Status line: provider · time to first option · time to last option · `audition: on (option n)` or `off (original)` · `swap: beat (T)`. Times belong to the current request; a new request shows `…` until its first option arrives.
- Request ids come from `main.ts`, and the machine drops options or completions carrying an old id. A new ⌘K while the tray is open aborts the old request and goes back to the original first.

## Beat-quantized swaps

### How it works (`src/quantize.ts`)
1. `nextBoundary(lastEnd, mode, beatsPerCycle = 4)`: beat → `ceil(lastEnd·4)/4`, cycle → `ceil(lastEnd)`, immediate → none. It is always ≥ `scheduler.lastEnd`, so nothing already scheduled changes.
2. `stitch(before, after, N)` is a `Pattern` whose query splits the span at `N`: `before` answers `[begin, N)` and `after` answers `[N, end)`. The query `State` (including the Drawer's `painters` and the Cyclist's `cyclist` control) passes straight through. Each onset comes from exactly one side, and a hap that crosses `N` is cut into fragments without onsets, which never trigger.
3. `Quantizer` wraps `scheduler.setPattern`. `repl.evaluate` calls `setPattern` *before* `afterEval`, so `drawer.invalidate(scheduler)` already sees the stitched pattern.
   - Only our own evaluations are quantized: `evaluateCode` sets `quantizer.armed` around its `repl.evaluate`. Ctrl+Enter and Play stay immediate, as in Strudel, and clear any pending stitch.
4. **A second press before `N`** (`lastEnd < pending.at`) re-stitches from `pending.base` at the same `N` and discards the earlier choice, so only the last one lands. Once a swap has landed, the next swap stitches from the landed pattern itself, so wrappers never nest.
5. `setcps` runs inside `repl.evaluate`, so tempo changes apply immediately, before the pattern boundary. Nothing extra was needed.
6. **Stopping** resets `scheduler.lastEnd` to 0, which would replay `base` up to `N` on restart. So when the `update` event shows `started` going true → false, the stitch is dropped (`settle(true)`).
7. **Highlighting** comes back only after the original has been re-evaluated **and** the swap has become audible (`quantizer.landed()`, i.e. `scheduler.now() ≥ N`). Until then the option is still playing, and its haps carry locations from the spliced code, not the editor text.
- Beats per cycle is `quantizer.beatsPerCycle` (default 4). The mode defaults to `beat`.

### Measurements
`await __shaper.measure(12)` taps `Pattern.prototype.queryArc` for calls carrying `{cyclist: 'cyclist'}` (the scheduler's own queries; the Drawer's are excluded) and records every swap's boundary. It presses random ready slots (and 0) 300–900 ms apart, then rebuilds what *should* have played from the sequence of landed swaps and compares onset by onset (time + full hap value). Run on the hi-hat line, cps 0.5 (1 cycle = 2 s):

| Mode | Swaps | Landed | Onsets played / expected | Missing | Extra | Kicks | Kick gaps | Boundaries | Press → audible |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beat | 12 | 11 | 101 / 101 | 0 | 0 | 19 | all 0.500 s | all on a quarter cycle | 185–624 ms |
| cycle | 12 | 4 | 76 / 76 | 0 | 0 | 17 | all 0.500 s | all on a whole cycle | 161–2065 ms |
| immediate | 12 | 12 | 107 / 107 | 0 | 0 | 20 | all 0.500 s | lastEnd (fractional) | 161–249 ms (milestone 1: 150–250) |

Beat mode, per swap (cycle at the key press → where it landed):

```
key 3  50.9914 → 51.25   517 ms
key 4  51.3487 → 51.5    303 ms
key 1  51.7514 → 52      497 ms
key 2  51.9434 → 52.25   613 ms
key 0  52.3727 → 52.5    255 ms
key 1  52.7007 → 53      599 ms
key 3  52.9380 → 53.25   624 ms
key 0  53.1914 → 53.5    replaced: key 3 below was pressed before 53.5, so only it landed
key 3  53.4074 → 53.5    185 ms
key 0  53.6314 → 53.75   237 ms
key 3  54.0420 → 54.25   416 ms
key 1  54.2900 → 54.5    420 ms
```

The `swapLog` entries for the earlier manual presses (1 → 3 → 0) landed at 20.75, 21.5 and 22.0, with `anchorKept: true` for each. In cycle mode, 8 of 12 presses were replaced before their boundary, and in every case only the last press before the boundary was heard. The worst case for a beat swap is about one beat (500 ms) plus the ~200 ms look-ahead.

## Milestone 1 fixes

- **Tray reset on outside evaluation.** **Signal: the `<strudel-editor>` element's `update` event.** Its `detail` is the whole merged repl state (`repl.mjs:51`), so `pending` stays true across unrelated updates such as `started`. The code therefore watches the `pending` **false → true edge**, which `repl.evaluate` emits synchronously on entry (`repl.mjs:227`). `ownEval` is true only during the synchronous start of our own `repl.evaluate` call, so the edge identifies the evaluation's source exactly.
  - When the matching `pending: false` arrives without an `evalError`, the tray gets `externalEval`: it aborts the request, re-enables highlighting if it was paused, and closes without re-evaluating, because the user's evaluation is already playing.
  - A failed outside eval leaves the tray alone, because the option really is still playing.
  - Verified: option 4 playing → Ctrl+Enter closed the tray; option 2 playing → the Play button closed it.
- **Audio on the first keypress.** A one-shot capture-phase `keydown` listener calls `getAudioContext().resume()` inside the key gesture, then dispatches a synthetic `mousedown` on `document`. That runs superdough's own one-shot `initAudioOnFirstClick` listener (worklets) exactly once. A real `mousedown` first removes our listener.
  - Note: superdough's own resume never runs. `initAudio` guards it with `(!audioCtx) instanceof OfflineAudioContext` (`superdough.mjs:291`), which is always false.
  - Verified after a reload: the AudioContext was `suspended`, ⌘K as the very first action made it `running`, then Esc and Ctrl+Enter played.
- **`repl.state.code` during audition.** Left as is, with a comment in `evaluateCode`. See the milestone 1 open problems above.

## Listening checklist (milestone 2)

Use headphones. Reload, and **don't click**. Press ⌘K, then Esc, then Ctrl+Enter.

- [ ] Audio starts with no mouse click.
- [ ] Put the cursor on the hi-hat line (no selection), press ⌘K, type `busier`, Enter. Four cards fill in one by one over about 1–4 s, each with a green insertion. The status line shows the first and last times.
- [ ] Press `1`. The change lands **on the next beat**, in time with a kick, never between kicks. Tap your foot to the kick and press `2 3 4 0` about one per second: every change lands on a kick or the beat between, and the kick never stumbles, doubles or drops.
- [ ] Press `2` then quickly `3` (within the same beat): you hear only option 3, not a flash of 2.
- [ ] Press `T` until it reads `swap: cycle (T)`. Changes now wait for the start of the bar (up to 2 s). Then `T` again for `immediate`: changes land within about ¼ s, at arbitrary points, as in milestone 1. Then back to `beat`.
- [ ] While auditioning, the outline boxes on the code disappear. Press `0`: they come back only once the original is audible, and on the right tokens.
- [ ] Click into the editor (tray still open) and press ⌥3: option 3 plays and nothing is typed. Esc goes back to the original.
- [ ] With an option playing, press Ctrl+Enter in the editor: the tray closes and what you hear is the editor's text.
- [ ] Open the tray, press `R` while cards are still arriving: the cards reset and a different set streams in.
- [ ] Select the whole bass line including its comma, press ⌘K, then Enter with no instruction. All four options play. None is marked failed.
- [ ] Audition one, press Enter: the line changes, the editor flashes, the music doesn't hiccup. One ⌘Z restores the line exactly.
- [ ] Press physical ⌘J and ⌘⇧J: each opens a one-card "mock fix" tray and Chrome doesn't open anything else.

## Open problems

- **Physical ⌘J / ⌘⇧J** still need a hand check (see Keyboard).
- **The `armed` window spans the whole async `repl.evaluate`** (a few ms, longer on the first eval while samples load). An outside Ctrl+Enter that lands inside that window would be quantized too. It's harmless (it just lands on the beat), but it isn't strictly "outside evals are immediate".
- **The Drawer's look-back after settling.** Once a swap has landed, `settle()` swaps the stitched wrapper for the plain new pattern, so a Drawer query reaching back before `N` would see the new pattern. Highlighting only shows the present, so nothing visible changes; a painter using `drawTime[0] < 0` (e.g. `pianoroll`) could repaint the last ≤1 cycle with the new pattern.
- **Fix modes skip the instruction box.** ⌘⇧J (intent rewrite) might want one once real models exist; `startCapture` in `main.ts` is the one place to change.
- **Widgets during audition** (from milestone 1) are still not handled.

---

# Milestone 3 notes: the validation pipeline

**No option reaches a card until it has been evaluated and queried silently, in a separate realm.** Checked in Chrome on macOS against `npm run dev` (keys via the Claude in Chrome extension, as in milestone 2). `npm test` (166 tests) and `npm run build` pass. `npm ls` still shows one copy each of `@codemirror/state`, `@codemirror/language` and `@strudel/core`. The worker bundle necessarily has its own copy of core (see below).

## Where things live

| File | What |
| --- | --- |
| `src/sandbox.ts` | The isolated evaluator: a private, never-started `repl()`, the stubs, and the snapshot/restore of globals |
| `src/validator.worker.ts` | The worker entry: `init` (stubs) → `ready`, then one `check` at a time |
| `src/validator.ts` | `Validator.validate(buffer, range, option, others)` (the brief's API), `normalizeCode`, `WorkerBackend` (queue + 250 ms pre-emptive timeout), `VALIDATION_TIMEOUT_MS` |
| `src/pipeline.ts` | `runRequest`: stream → validate in arrival order → one retry with feedback per slot → tray events |
| `src/mockProvider.ts` | `faultRate`, `faultSeed`, `faultKind`, `retryFails`, `faultLog` |
| `src/trayMachine.ts` | Slots: `pending · validating · retrying · ready · dropped · failed · empty` |
| `src/main.ts` | Wiring, rendering, dev controls, `__shaper.soak()` and `__shaper.measure(n, { validate })` |

## How Strudel evaluates, and why validation needs its own realm

- `core.evaluate` (`@strudel/core/evaluate.mjs`) transpiles, then runs the code with `Function()` against **`globalThis`**. Every Strudel name is a global installed by `evalScope` (which also fills `strudelScope`).
- `setcps`/`setCps`/`setcpm`/`setCpm`, `hush`, `all`, `each`, `cpm` and `Pattern.prototype.p/q/d1–9/p1–9/q1–9` are **closures over one `repl()`'s scheduler and pattern table**. `repl.evaluate` re-installs them on every call (`injectPatternMethods`, `repl.mjs`). So "how `setcps` reaches the scheduler" is: the global `setcps` is whichever repl last evaluated. A second repl on the main thread would take over those globals during the live repl's `await` gaps, and the live code's `setcps` could land on the wrong scheduler. **The main thread can't be made safe by swapping globals around a check.**
- `@strudel/core`, `mini`, `tonal` and `transpiler` load and run **without `window`/`document`** (verified in Node and in the worker). `Cyclist.setPattern(p, false)` never starts the clock (`cyclist.mjs:123`).
- **`Pattern.queryArc` swallows query errors** (`pattern.mjs:414-420`: it logs `[query] error` and returns `[]`). The live scheduler would just play silence for that tick. The query stage therefore calls `pattern.query(new State(new TimeSpan(0, 2)))` directly.
- Mini-notation errors (`s("hh*8[")`) are thrown by the **transpiler**, so they count as `syntax`. Most bad arguments (`.fast("x")`, `.scale("Q:nope")`, `.segment("x")`) don't throw at all: they just produce 0 onsets.

## Worker decision: validation runs in a Web Worker

The worker is a separate realm with its own `globalThis`, `Pattern.prototype` and a private `core.repl()`. It has no DOM, no AudioContext and no `soundMap`, so a check **cannot** reach the live scheduler, tempo, pattern, editor or sound map. Strudel's own `repl.evaluate(code, /*autostart*/ false)` handles `$:`, `hush`, `all`, `each`, `setcps` and `cpm` exactly as live, but against the private scheduler (its cps is set to the live cps before each check, so `.cpm()` matches).

It is also the only place a runaway check can be stopped. `WorkerBackend` starts a 250 ms timer per check. If the timer fires, it `terminate()`s the worker, spawns a new one and sends the stub list again. Verified: `s("hh*8").fast(1e9)` → `timeout` at 250 ms, `respawns: 1`, and the next check passed.

Costs: one module worker (524 kB in the build: core, mini, tonal, transpiler) and its own copy of `@strudel/core` (unavoidable for a separate realm; `npm ls` is unaffected). `vite.config.ts` sets `worker.format: 'es'`.

### What is stubbed, and why

The worker loads **core, mini, tonal and transpiler for real**. After the live `prebake` resolves, the main thread sends the names live code can call: `Object.keys(strudelScope)` filtered to those defined on `globalThis`, plus the own function names on `Pattern.prototype`. The worker stubs the ones it doesn't have. These come from modules that need the DOM, AudioContext, network or MIDI. Measured: **185 globals and 38 methods**.

- **Globals → `() => silence`** (each call is recorded in `sandbox.stubCalls`):
  - `@strudel/webaudio` + superdough (the reason the sound map can't change: these are no-ops here): `samples`, `registerSound`, `registerSynthSounds`, `registerZZFXSounds`, `registerSampleSource`, `registerSamplesPrefix`, `registerWaveTable`, `registerWorklet`, `aliasBank`, `soundAlias`, `soundMap`, `resetLoadedSounds`, `setDefault`, `setDefaultValue(s)`, `resetDefaults`, `resetDefaultValues`, `setVersionDefaults`, `setGainCurve`, `setMaxPolyphony`, `setMultiChannelOrbits`, `initAudio`, `initAudioOnFirstClick`, `getAudioContext`, `setAudioContext`, `setDefaultAudioContext`, `superdough`, `superdoughTrigger`, `webaudioOutput`, `webaudioRepl`, `loadBuffer`, `getSound`, `fetchSampleMap`, `processSampleMap`, `connectToDestination`, `analysers`, `getAnalyserById`, `drawTimeScope`, `drawFrequencyScope`, `dough`, `doughsamples` and about 60 more node and envelope helpers (`getOscillator`, `getEnvelope`, `getLfo`, …).
  - `@strudel/draw`: `pianoroll`, `drawPianoroll`, `__pianoroll`, `getDrawContext`, `cleanupDraw`, `Drawer`, `Framer`, `getTheme`, `setTheme`, `pitchwheel`, `getPunchcardPainter`, `colorMap`, `rescale`, `moveXY`, `zoomIn`, `x`, `y`, `w`, `r`, `angle`, `fill`, …
  - `@strudel/codemirror`: `StrudelMirror`, `initEditor`, `flash`, `highlightMiniLocations`, `updateMiniLocations`, `updateWidgets`, `updateSliderWidgets`, `registerWidget`, `settings`, `themes`, `toggleComment`, … **Exception: `slider` and `sliderWithID` return `pure(value)`**, so `.gain(slider(0.6))` still sounds. The transpiler rewrites `slider(v)` to `sliderWithID(id, v, …)`.
  - `@strudel/hydra`: `H`, `initHydra`, `clearHydra`
  - `@strudel/soundfonts`: `registerSoundfonts`, `loadSoundfont`, `setSoundfontUrl`, `soundfontList`, `getFontBufferSource`, `startPresetNote`
  - `@strudel/midi`: `midin`, `WebMidi`, `enableWebMidi`, `midimaps`, `defaultmidimap`, `midicontrolMap`, `midikeys`, `midisoundMap`
- **`Pattern.prototype` methods → `function () { return this }`** (all 38): `draw onPaint getPainters animate x y w h angle r fill rescale _rescale moveXY _moveXY zoomIn _zoomIn pianoroll punchcard wordfall spiral pitchwheel supradough dough fscope tscope scope spectrum _pianoroll _punchcard _spiral _scope _pitchwheel _spectrum markcss piano soundfont midi`
- **Not stubbed, provided for real by the worker's own repl:** `setcps`, `setCps`, `setcpm`, `setCpm`, `hush`, `all`, `each`, `cpm`, `compileKabel`, `.p`/`.q`/`d1–9`/`p1–9`/`q1–9`.
- **Gotcha found:** `density`, `plywith` and `plyforeach` are in the live `strudelScope` but **not on the live `globalThis`**. Core exports them twice internally (e.g. `density` is both a `fast` synonym and a control), so `export *` drops the ambiguous names. Stubbing them would have made validation accept code the live repl rejects, so names are filtered by `globalThis`. `density(2, pat)` is now `eval: density is not defined`, as live.
- **Between checks**, the worker restores the own keys of `globalThis` and `Pattern.prototype` to a post-init snapshot. A `register('foo', …)` or `globalThis.x = …` in one option can't leak into the next check (tested).

### Proving the live session is untouched

- `test/sandbox.test.ts` runs the sandbox in the **same** realm as a stand-in live repl (the harder case) on a buffer with `setcps(1)`, `samples(…)`, `registerSound(…)`, `register('wobble', …)`, `hush()` and `.pianoroll()`. The live cps stays 0.5, the live pattern stays the same object, the sound list is unchanged, `wobble` is gone afterwards, and the live repl's next `setcps(0.7)` still reaches its own scheduler.
- In the browser, `measure(n, { validate: true })` snapshots the live state before and after. Every other validation batch splices into a buffer whose `setcps(0.5)` was changed to **`setcps(1)`** (thousands of such checks per run). Results are below.

## Validator stages (`Validator.validate`)

1. Splice into the **current** buffer at the **current** (stale-guard-mapped) range: `runRequest` reads `getBuffer()`/`getRange()` when each validation runs, not when the option arrived (tested).
2. **identical**: `normalizeCode(option) === normalizeCode(selection)`.
3. **duplicate**: against options already **accepted** in this request, in arrival order.
4. **syntax**: `transpiler()` throws (JS syntax *and* mini-notation).
5. **eval**: `repl.evaluate` returns `undefined` (thrown), or `silence` (repl's substitute for "no pattern", e.g. a buffer that is only `setcps(1)`).
6. **query**: `pattern.query(State(TimeSpan(0, 2)))` throws. Onsets are counted.
7. **Warnings**, judged by the **option's own events**: haps carry their mini-notation source locations, and onsets whose location starts inside the spliced option are the option's. This was found in the browser: with whole-buffer counting, `.degradeBy(1)` on one stack line never warned, because the kick and bass keep sounding. If the option has no mini-notation (e.g. `sound(seq('hh','hh'))`), it falls back to the whole buffer (`eventScope: 'buffer'`). `empty` = 0 onsets. `unknown-sample` = a sound key not in the live `soundMap` (read only), keyed like superdough: `bank_s` lowercased, `:n` stripped, rests skipped, no `s` → `triangle`.
8. **timeout**: more than `VALIDATION_TIMEOUT_MS = 250` ms. The worker backend pre-empts; the in-process sandbox (tests) checks after the fact.

`normalizeCode`: outside strings, whitespace disappears (one space is kept between two word characters). Inside `"…"`, `'…'` and `` `…` ``, runs collapse to one space and are trimmed. So `s( "hh*8" ) .gain( 0.6 )` is identical to `s("hh*8").gain(0.6)`, but `"hh hh"` ≠ `"hhhh"`.

## Retry with feedback (`src/pipeline.ts`)

- `OptionRequest.feedback?: { previousCode, error }`; nothing else changed.
- Every first failure (`syntax`/`eval`/`query`/`timeout`/`identical`/`duplicate`) gets **one** replacement request for that slot, with the current buffer and range. The feedback is `syntax: Unexpected token (6:1)`, `unknown function: s(...).wobble is not a function`, … or, in plain words, "This option is the same as the original selection. Suggest a different variation." / "This option is the same as option 2. …". If the replacement fails too, the slot is dropped for good.
- Retries start immediately and run alongside the rest of the stream. Validation stays serial and in arrival order. Everything honours the request's `AbortSignal`: nothing is emitted after an abort (tested mid-retry). Events carry the request id, and the machine ignores stale ones. `requestDone` is sent only when the stream has ended and every validation and retry has settled.
- Two mock bugs that parallel retries exposed (both fixed and tested): a replacement could pick a transform the stream had *planned* but not yet yielded, and two concurrent replacements could pick the same one. Both showed up as permanent `duplicate` drops.

## Faulty mock

| Kind | What it produces (trailing `,`/`;` kept) | Handled as |
| --- | --- | --- |
| `syntax` | `….fast(2` or the first string's closing quote removed | dropped → retried |
| `unknown-function` | `….wobble(2)` | `eval` ("unknown function") → retried |
| `unknown-sample` | `s("zzzz*4")` | **warning** `unknown sample: zzzz`, playable |
| `runtime` | `….fmap(v => v.velocity.toFixed(2))`: transpiles and evaluates, **throws only when queried** (no event has a velocity; confirmed on all three lines). `.sometimesBy(0.5, x => x.wobble(2))` also throws only at query. | `query` → retried |
| `empty` | `….degradeBy(1)` | **warning** `empty`, playable |
| `identical` | the selection with an extra space (`s( "hh*8")…`) | dropped → retried |
| `duplicate` | an earlier *clean* option with an extra space (falls back to the next kind if there isn't one) | dropped → retried |

- Faults use their own prng stream (`faultSeed`, default `seed`). At `faultRate = 0` the options and delays are **exactly** milestone 2's (pinned in a test against output recorded from the milestone 2 mock).
- With `feedback`, the mock returns one valid transform not yet planned or issued for this request. With `retryFails`, it returns a fault (`faultKind` or `syntax`). Since there are only 7 transforms, a request with 4 planned options and 4 retries can run out; the last replacement is then a duplicate and is dropped. This happened once in 30 requests.
- **Turning it on (dev only):** `http://localhost:5173/?faultRate=0.5` plus optionally `&fault=syntax|unknown-function|unknown-sample|runtime|empty|identical|duplicate`, `&retryFails=1` and `&seed=123`. Live: `__shaper.mock.faultRate = 0.5`, `__shaper.mock.faultKind = 'runtime'`, `__shaper.mock.retryFails = true`. The status line then reads `provider: mock (faults 50%)`.

## Tray

- Cards appear only after validation. Placeholders read `waiting for option` → `validating…` → (`retrying… (syntax)`) → the card, or `dropped: unknown function` with the full message in the hover title.
- Cards with warnings show a badge (`empty`, `unknown sample: zzzz`) and can still be auditioned. A replacement shows a blue `retried` badge, and its title names what it replaced.
- Status line: `provider: mock (faults 60%) · first 1.1 s · last 3.4 s · 4 ok · 1 retried · 0 dropped · validation 4.4 ms avg / 8.4 ms max · audition: off (original) · swap: beat (T)`. first/last now mean the first card *shown* and the last slot settled. Provider arrival times are logged as `[shaper] request timing`.
- The audition-time `failed` state stays as a backstop. It was never reached in any soak.
- ⌘⇧J opens the instruction box (empty is fine) and then requests `fix-rewrite`; ⌘J still goes straight to the tray. Both verified.

## Measurements (Chrome, cps 0.5)

### Exit-criteria soak: `await __shaper.soak({ requests: 36, faultRate: 0.5, seed: 77 })`
Kick, hi-hat and bass lines in turn, through the real tray. Every card that appeared was auditioned on the live repl (immediate swaps).

| Requests | Options | Faults | Kinds seen | Live auditions | **Failed cards** | **Hard faults accepted** |
| --- | --- | --- | --- | --- | --- | --- |
| 36 | 192 | 70 | 7 / 7 | 144 | **0** | **0** |

```
syntax            10× retried after syntax → replacement accepted
unknown-function  10× retried after unknown function → replacement accepted
runtime           10× retried after query error → replacement accepted
identical         11× retried after identical → replacement accepted
duplicate          6× retried after duplicate → replacement accepted
empty             12× warned (empty); 1× retried after duplicate → replacement accepted
unknown-sample    10× warned (unknown-sample)
```
(The one "empty → duplicate" was a second `degradeBy(1)` in the same request.) An earlier 30-request run (seed 11) gave the same picture: 169 options, 68 faults, 7/7 kinds, 119 auditions, 0 failed, and 1 permanent drop from the mock running out of transforms.

`retryFails` run (12 requests): every retried slot was **dropped for good**, with 0 failed cards and 0 hard faults accepted. Under `retryFails` the broken replacements are themselves logged as `syntax` faults, which shows as "dropped for good: syntax" rows.

### Audio during validation: `measure(n, { validate: true })`
Background load: batches of 4 faulty-mock options validated **back to back** against the live buffer for the whole run, every other batch with `setcps(1)`. That is far more than 4 per request, about 1,800–2,000 checks per second.

| Run | Swaps / landed | Onsets played / expected | Missing | Extra | Kicks | Kick gaps | Checks (`setcps(1)` batches) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beat | 12 / 11 | 102 / 102 | 0 | 0 | 22 | all 0.500 s | 21,213 (3,413) |
| immediate | 12 / 12 | 90 / 90 | 0 | 0 | 18 | all 0.500 s | 18,487 (2,975) |
| hold 20 s, no swaps | 0 | 161 / 161 | 0 | 0 | 40 | all 0.500 s | 39,749 (6,381) |
| hold 10 s (final code) | 0 | 83 / 83 | 0 | 0 | 21 | all 0.500 s | 17,727 (2,834) |

Isolation, every run: **cps 0.5 → 0.5**, anchor kept, editor text kept, `soundMap` kept (1650 sounds, same key hash), main-realm `Pattern.prototype` and live `setcps` kept, 0 timeouts. In the no-swap hold the live pattern is the **same object** throughout. (One hold reported `patternKept: false`: an Esc just before it had re-evaluated the original in beat mode, and the Quantizer's `settle()` replaced its stitched wrapper mid-run. Re-run once settled: `true`.)

### Validation time per option
- Warm worker, hot loop: **0.26–0.29 ms average**, p95 0.4 ms, max 1.2–1.5 ms (13 ms once). Event counts track the code, so this is real work (`hh*9` → 18 onsets in 2 cycles), with a 0.5 ms main-thread round trip.
- Inside a real request (the worker idle between options): **4–6 ms per option**. The first check after a page load took 7.6 ms.
- `faultRate = 0`, 6 requests: each card appears **3–9 ms** after the provider's option arrives (first card 338 ms vs 332 ms raw, …). Otherwise milestone 2 behaviour is unchanged: same options, same delays, 4 cards. Fix modes now show the `.fast(1)` no-op.

## Listening checklist (milestone 3)

Use headphones. Open `/?faultRate=0.5`, press ⌘K → Esc, then Ctrl+Enter.

- [ ] Put the cursor on the hi-hat line, ⌘K, Enter. Placeholders go `waiting for option` → `validating…`, some `retrying… (syntax)` and similar, then cards. **Nothing broken is ever a card.**
- [ ] The status line shows `n ok · n retried · n dropped · validation x ms avg / y ms max` and `provider: mock (faults 50%)`.
- [ ] Throughout the request (and pressing R a few times), the kick never stumbles and the tempo never changes.
- [ ] A card with an `empty` badge plays: the hats go silent, and kick and bass continue. A card with `unknown sample: zzzz` plays: the hats go silent and the console logs a missing sound. Neither hiccups.
- [ ] A `retried` card plays like any other. Hover it to see what it replaced.
- [ ] `__shaper.mock.retryFails = true`, then R: some slots end `dropped: syntax` (hover for the message) and can't be auditioned.
- [ ] `__shaper.mock.faultKind = 'runtime'; __shaper.mock.faultRate = 1`, then R: every slot shows `retrying… (query error)` and fills with a replacement.
- [ ] Edit the first line to `setcps(1)` **without evaluating**, then ⌘K on the hi-hat line, Enter, and audition cards. Validation sees `setcps(1)` in the buffer but the tempo doesn't change. (Auditioning a card *does* evaluate the buffer, including `setcps(1)`, so the tempo then doubles. That's expected live behaviour, not validation.)
- [ ] Reload with no query string: cards look and play as in milestone 2, a few ms later.
- [ ] Physical ⌘⇧J on a line opens the instruction box. Enter gives a one-card "mock fix (no-op)" tray. Physical ⌘J goes straight to the tray.

## Open problems

- **An error elsewhere in the buffer fails every option.** The whole spliced buffer is checked, so a broken line 3 makes every option for line 4 fail on that line 3 error. Each one is retried, then dropped, with an accurate message. Fix: check the unmodified buffer once per request, and if it fails the same way, report "the buffer itself fails" instead of blaming the options.
- **Validated against the buffer at validation time.** Edits elsewhere *after* a card is validated aren't re-checked; the audition-time `failed` state is the backstop.
- **Stub fidelity.** Stubbed draw/webaudio/codemirror/hydra/midi calls are assumed valid (wrong arguments to them aren't caught). `await samples(...)` resolves to `silence`. Sounds that a `samples()` call *in the option* would load show as `unknown sample`. `.piano()` (defined by the repl's prebake) is a pass-through, so its notes default to `triangle`.
- **"No pattern" is `=== silence`.** A buffer that is *only* `hush()` or `silence` is dropped as `eval`, though it is arguably a legitimate choice.
- **Option-scoped events need mini-notation** in the option. Options built only from single-quoted strings, numbers or signals fall back to whole-buffer counting, where an empty option inside a sounding stack isn't flagged.
- **Mock exhaustion**: with 7 transforms, 4 planned options plus 4 retries in one request can't all be distinct. Real providers won't have this limit.
- **Worker memory**: one worker for the page's lifetime, replaced after a timeout. The pre-emption is verified, but not long sessions (hours).
