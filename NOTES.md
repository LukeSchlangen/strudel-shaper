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
- Fix modes return one option, the selection unchanged, labelled "mock fix".
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
| Intent rewrite | ⌘/Ctrl+⇧J | ✅ opens the tray straight away, mode `fix-rewrite` |
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
