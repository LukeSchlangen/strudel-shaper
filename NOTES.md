# Current state (read this first)

Strudel Shaper is a browser Strudel live-coding editor. The user selects code and presses a key. The model returns 1–4 code options with 1–4 word labels, never prose. The user auditions them on the running clock and commits one.
- ⌘K **shapes** the selection.
- ⌘J makes a **minimal fix**.
- ⌘⇧J makes an **intent rewrite**.
- **✨ New idea** (or ⌘K on an editor with no runnable code) **generates** four complete starter programs for a beginner. See "New idea: generate mode" at the end.

Milestones 1–5 and New idea are done; the sections below are their history.

## Run it

| What | How |
| --- | --- |
| App + model proxy | `npm run dev` (Vite on :5173, proxy on 127.0.0.1:8787). Put `ANTHROPIC_API_KEY` in `.env` (see `.env.example`). Open `http://localhost:5173/?provider=claude`. Without `?provider` it uses the offline mock. |
| Tests, build, key scan | `npm test` (489 tests, no network), `npm run build`, `npm run check:key`. All three must pass before a commit. |
| Eval (costs cents) | `npm run eval -- --model claude-haiku-5-5` (shape, 20 requests). `npm run eval -- --mode fix --model claude-haiku-5-5` (fix, 15 requests). `npm run eval -- --mode generate --model claude-sonnet-5-5` (New idea, 5 requests). Add `--only id,id` or `--label x`. Reports go to `eval/reports/`. |
| Listening | `http://localhost:5173/eval/listen.html` (dev server): N/P step through requests, 1–4 audition, 0 original. |
| Prompt size | `npm run count:prompt` (free count_tokens endpoint) |
| Reference | `npm run build:reference`. After a Strudel upgrade, first run `await __shaper.saveScope()` in the dev page. |
| Dev console | `__shaper` gives `mirror`, `view`, `scheduler`, `quantizer`, `swapLog`, `validator`, `measure(n)`, `soak()` and `mock`. `?faultRate=0.5` turns on the faulty mock. |

## Current defaults

| Setting | Default | Where / override |
| --- | --- | --- |
| Model, shape (⌘K) | the header select (Haiku 5.5 when `?provider=claude`) | `?model=`, Alt+P |
| Model, ⌘J minimal fix | **Haiku 5.5** | `MODE_DEFAULT_MODELS` (`server/providers/models.ts`); `?fixModel=` |
| Model, ⌘⇧J rewrite | **Sonnet 5.5** | same; `?rewriteModel=` |
| Model, ✨ New idea (generate) | **Sonnet 5.5** (Gemini: 4 argon) | same; `?generateModel=` |
| Thinking / effort | off / low, both models | `?thinking=` `?effort=` |
| Strategy | `single` (one call per option set; fix modes always single) | `?strategy=parallel` (shape only) |
| Swap timing | beat | T / Alt+T |
| Warm-up | on, for the selected model | `?warmup=0` |
| Limits | 4 options (2 for a minimal fix; generate always asks for 4); `MAX_TOKENS` 2048; `RATE_LIMIT_PER_MIN` 20; 20 s upstream idle timeout | `.env` |
| Validation | 250 ms per check (`VALIDATION_TIMEOUT_MS`); fingerprints over 8 cycles (`FINGERPRINT_CYCLES`) | `src/validator.ts`, `src/sandbox.ts` |
| Fix cards | char diff when ≤ 12 changed runs (`MAX_CHAR_CHANGES`); `large change` badge above 20 characters (`LARGE_CHANGE_CHARS`) | `src/diff.ts` |

## Rules no change may break

- Import `@strudel/repl/repl-component.mjs`, never the package root. Keep the CodeMirror pins in `package.json` and `resolve.dedupe` in `vite.config.ts`.
- **Auditioning:**
  - Audition with `mirror.repl.evaluate(code)`.
  - The Quantizer quantizes only our own evaluations (and snapshot restores). A restore to a snapshot taken with the clock stopped stops the clock once the swap has landed.
  - An outside evaluation (Ctrl+Enter, Play) resets the tray.
  - Highlighting pauses and widgets are held while auditioning.
- **Commit:** one `isolateHistory.of('full')` transaction, so one ⌘Z undoes it.
- **Validation** runs only in the worker realm, never on the main thread.
- **The API key** stays server-side: `npm run check:key` must pass.
- **Nothing provider-specific in the browser:** every mode goes through the `Provider` interface, `RemoteProvider` and the NDJSON protocol (`src/remoteProtocol.ts`). A new model is a new server adapter.
- **Fixes happen only when the user asks** (⌘J / ⌘⇧J). Nothing diagnoses or fixes code on its own.
- **Prompt cache:** every mode's rules live in the cached system prompt (`server/prompt.ts` `ROLE`). Per-request text goes only in the user message.
- No test calls the real API.

## Where things live

| Area | Files |
| --- | --- |
| Wiring, keys, rendering | `src/main.ts`, `src/style.css` |
| Tray state machine | `src/trayMachine.ts` (effects incl. `snapshotPlaying` / `restoreSnapshot`) |
| Capture and fix targets | `src/generate.ts` (`noRunnableCode`, `generateCapture`), `src/capture.ts` (`captureRange`, `captureAt`), `src/fixTarget.ts` (`diagnoseFix`, `trayFix`, `noRequestReason`), `src/errorPosition.ts` |
| Validation | `src/validator.ts` (shape and fix rules), `src/sandbox.ts` (worker realm, fingerprint), `src/validator.worker.ts`, `src/pipeline.ts` (retries), `src/feedback.ts` |
| Audio timing | `src/quantize.ts` (`Quantizer`: `swapTo`, `playing`) |
| Diffs | `src/diff.ts` (word / char diffs, `changeSize`) |
| Providers | `src/provider.ts`, `src/remoteProvider.ts` (`modelForMode`), `src/mockProvider.ts` |
| Proxy | `server/app.ts`, `server/prompt.ts`, `server/providers/claude.ts`, `server/providers/models.ts` |
| Eval | `eval/run.ts`, `eval/fixtures.json` (20 shape + 15 fix + 5 generate requests), `eval/summary.ts`, `src/listen.ts` |

## Live open problems

Most important first. Details are in the milestone sections.

1. **"Checked alone" cards can't be heard** while the buffer fails elsewhere: auditioning plays the whole spliced buffer (M4). This also covers fixes when the buffer has a second error. An "audition alone" mode is out of scope so far.
2. **The warm-up only warms the selected model.** The first ⌘⇧J or New idea of a session (Sonnet) pays the prompt-cache write: about $0.02 and a slower first card (M5). For New idea this is often the *first* request a beginner makes.
3. **Haiku often returns 3 shape options, not 4** (M4).
4. **Models add numbers to control patterns** (`.add(2)` on `n(...)` or `note(...)`), which is a no-op in this Strudel version. The sounds-identical check now catches it and retries, but the reference could warn about it (M5).
5. **Some broken code plays partly and isn't diagnosed as broken:** a bad chord name inside `<…>`, or `.gain("loud")`. ⌘J says "nothing to fix" (M5).
6. **Validation is a snapshot:** edits made elsewhere after a card validates aren't rechecked. The audition-time `failed` state is the backstop (M3).
7. **Stub fidelity:** draw, webaudio, codemirror, hydra and midi calls are assumed valid in the worker (M3).
8. **"No pattern" is `=== silence`:** a buffer that is only `hush()` is dropped as an eval error (M3).
9. **Option-scoped events need mini-notation in the option:** without it, events are counted over the whole buffer (M3).
10. **`repl.state.code` / `isDirty`** track the auditioned code during audition. Nothing reads them yet (M1).
11. **Widget glitches:** two `._scope()` widgets render wrongly (upstream). An option that adds a scope shifts the scope indexes during audition (M4).
12. **Timing:** swap latency is fixed at about 150–250 ms by Strudel's look-ahead (M1). The `armed` window spans the whole async evaluate (M2). The Drawer's look-back after `settle()` sees the new pattern (M2).
13. **Snapshots:** `src/generated/` and the sound summary are snapshots of the live scope; the summary lists only 12 drum machines in full (M4).
14. **Eval and housekeeping:** the eval measures the proxy in-process, so network time is excluded (M4). Retries cost a full cached prompt each (M4). The worker isn't tested over hour-long sessions (M3). The mock runs out of transforms (M3). The bundle is 1.8 MB (M1).
15. **New idea:** the starter code hides the button until the editor is cleared; undo after a commit leaves the idea playing; beginner readability is prompted, not checked; Haiku vs Sonnet not yet compared on the generate eval (New idea).

---

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
- **No shortcut changes were needed.** The test keys were sent through the DevTools protocol; physical ⌘J / ⌘⇧J were later confirmed by hand as well.

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

- **The `armed` window spans the whole async `repl.evaluate`** (a few ms, longer on the first eval while samples load). An outside Ctrl+Enter that lands inside that window would be quantized too. It's harmless (it just lands on the beat), but it isn't strictly "outside evals are immediate".
- **The Drawer's look-back after settling.** Once a swap has landed, `settle()` swaps the stitched wrapper for the plain new pattern, so a Drawer query reaching back before `N` would see the new pattern. Highlighting only shows the present, so nothing visible changes; a painter using `drawTime[0] < 0` (e.g. `pianoroll`) could repaint the last ≤1 cycle with the new pattern.
- ~~**Fix modes skip the instruction box.**~~ Superseded in milestone 3: ⌘⇧J opens the instruction box.
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

---

# Milestone 4 notes: the first real model (Claude)

`?provider=claude` (or the header select, or Alt+P) sends ⌘K requests to Claude through a local proxy; options stream in, are validated as before, and audition and commit work unchanged. The mock stays available (offline demo, faulty mode) and still answers ⌘J / ⌘⇧J. Checked in Chrome on macOS against `npm run dev`. `npm test` (291 tests) and `npm run build` pass; no test calls the real API.

## Where things live

| File | What |
| --- | --- |
| `server/index.ts`, `server/app.ts` | The proxy (Hono on `@hono/node-server`, 127.0.0.1:8787): `POST /api/options` (NDJSON), `POST /api/warmup`. Reads `.env` |
| `server/providers/claude.ts` | The Claude adapter: request building, streaming, idle timeout, refusal/max_tokens handling, the parallel strategy, warm-up |
| `server/prompt.ts` | Role and rules, prompt layout, the output schema |
| `server/jsonStream.ts` | Incremental parser: emits each option the moment its JSON object closes |
| `server/providers/postprocess.ts`, `models.ts`, `server/errors.ts`, `server/rateLimit.ts` | Fitting options back into the buffer; per-model prices and thinking settings; SDK error → status-line message; the per-minute limit |
| `src/remoteProtocol.ts` | The wire format shared by browser, proxy and eval (provider-neutral) |
| `src/remoteProvider.ts` | `RemoteProvider`: the browser side of any proxied model. Nothing Claude-specific |
| `src/feedback.ts` | Retry feedback as instructions, `SILENCE_WORDS`, reason labels |
| `src/soundSummary.ts` | The loaded sounds, compacted for the prompt |
| `src/widgets.ts` | Widget hold during audition, slider id bridge |
| `scripts/build-reference.ts` → `src/generated/strudel-reference.md` | The Strudel reference in the prompt (`npm run build:reference`) |
| `src/generated/scope.json`, `sounds.json` | The live scope and sound names, saved from the page with `await __shaper.saveScope()` (dev only) |
| `eval/` | The eval harness, fixtures, reports and `listen.html` |

`Provider.generateOptions(req, signal, hooks?)` gained an optional third argument: `hooks.onStats` receives provider-neutral stats (timings, token counts, cost). `ProviderError(kind, message)` is the provider-neutral failure. DiffusionGemma only needs a new server adapter that produces the same NDJSON lines.

## Anthropic API details used (read 2026-10-15)

- **Models** (https://platform.claude.com/docs/en/models/overview): `claude-haiku-5-5` (default) and `claude-sonnet-5-5`. Prices per MTok (https://platform.claude.com/docs/en/about-claude/pricing), input / 5-min cache write / cache read / output: Haiku 5.5 $0.10 / $0.125 / $0.01 / $0.50 (prompts ≤ 100k tokens); Sonnet 5.5 $2 / $2.50 / $0.10 / $10. `server/providers/models.ts` holds them; costs in the status line and eval come from them.
- **Structured outputs** (https://platform.claude.com/docs/en/build-with-claude/structured-outputs): `output_config.format = { type: "json_schema", schema }`. Works with streaming: the JSON arrives as ordinary `text_delta`s, which `server/jsonStream.ts` parses incrementally.
  - **Surprise: `maxItems` is not supported, and `minItems` only accepts 0 or 1.** "3–4 options" can't be in the schema. It's in the prompt, and the server keeps at most 4 (`MAX_OPTIONS`). One schema (`minItems: 1`) serves full requests, retries and parallel calls, so they share one compiled grammar.
  - The first request with a new schema compiles a grammar (cached 24 h from last use). Changing the schema's structure recompiles it and also invalidates the prompt cache; changing only names/descriptions doesn't.
  - `stop_reason: "refusal"` and `"max_tokens"` can leave invalid JSON. Both become an error line after any options that did complete.
- **Thinking** (https://platform.claude.com/docs/en/build-with-claude/thinking) and **effort** (https://platform.claude.com/docs/en/build-with-claude/effort): both models think adaptively by default, with `display: "omitted"` (thinking tokens are billed and delay the first text token, but aren't shown).
  - Haiku 5.5 turns it off with `thinking: { type: "disabled" }`, at effort high or below. Default effort `medium`.
  - **Surprise: Sonnet 5.5 rejects `disabled` with a 400**; its lowest setting is `thinking: { type: "between_tools" }` (no up-front thinking; without tools that means none), at effort high or below. Default effort `high`.
  - `output_config.effort`: `low | medium | high | xhigh | max`. We only allow up to `high`.
- **Prompt caching** (https://platform.claude.com/docs/en/build-with-claude/prompt-caching): `cache_control: { type: "ephemeral" }` (5 min), up to 4 breakpoints, minimum 512 tokens on both models, prefix order tools → system → messages. Changing thinking or effort settings invalidates it. Usage reports `cache_creation_input_tokens` and `cache_read_input_tokens`.
- **Streaming** (https://platform.claude.com/docs/en/build-with-claude/streaming): `client.messages.create({ …, stream: true }, { signal })` with the official `@anthropic-ai/sdk` (0.134.0). Events used: `message_start` (input and cache usage), `content_block_delta` / `text_delta`, `message_delta` (stop reason, output tokens). The SDK's `signal` cancels the HTTP request.
- **Other surprises:** the SDK's default timeout is 10 minutes, and in the first sweep two streams stalled for 460 s and 940 s. The adapter now aborts a call after 20 s without a stream event (`idleTimeoutMs`) and reports `timeout`. Overloaded (529) surfaces as `InternalServerError` with `status === 529`.

## The proxy

- `npm run dev` starts Vite and the proxy (`concurrently`); Vite forwards `/api/*` to `127.0.0.1:8787`. `npm run dev:web` is Vite alone.
- `ANTHROPIC_API_KEY` comes from `.env` (git-ignored; `.env.example` is committed) or the shell environment. The proxy binds to 127.0.0.1 only.
- **NDJSON lines:** `{type:"option",label,code}` per option; then `{type:"done",timing,usage,costUsd}`; or `{type:"error",kind,message}`.
  - `kind` is one of `auth`, `rate-limit`, `local-rate-limit`, `overloaded`, `refusal`, `truncated`, `bad-request`, `network`, `timeout`, `internal`.
  - Messages are short and fixed ("The API key was rejected. Check ANTHROPIC_API_KEY in .env."). Stack traces only reach the server log.
- **Guard rails:** `MAX_TOKENS` (default 2048, clamped to 4096); `RATE_LIMIT_PER_MIN` (default 20) counts every upstream call, so one ⌘K with four retries uses five; the SDK retries once (`maxRetries: 1`).
- **Logging:** one line per request: model, strategy, retry or not, ms, first option ms, usage and cost; `aborted: true` when the browser went away.
- **Abort:** the request's own signal (`c.req.raw.signal`, which `@hono/node-server` aborts when the client disconnects) is passed to the SDK.
  - Verified with `curl --max-time 1` against the real API: `{"aborted":true,"ms":1003}`, and no usage line.
  - Verified in Chrome: R while cards were streaming logged `aborted … ms: 13`; Esc twice logged `aborted … ms: 511`.
  - Tested with a fake SDK client (`test/claudeAdapter.test.ts`).

### The key never reaches the browser

- `npm run check:key` builds and scans every file in `dist/` for the key's value, for `sk-ant-` followed by 10 or more key characters, and for the string `ANTHROPIC_API_KEY`. Result: 8 files scanned, nothing found.
- Only `server/` reads the key; `src/` has no access to `process.env`, and Vite only exposes `VITE_`-prefixed variables to the client.
- Response bodies are option, done and error lines built by our own code; the auth error text names the variable, never its value.

## The prompt

In cache order (prefix first):
1. **System block 1, cached:** the role and rules (`server/prompt.ts` `ROLE`), then the Strudel reference. ~5.1k tokens. Identical for every request, so every request after the first in a 5-minute window reads it from the cache.
2. **System block 2, cached:** the sound summary. ~2.2k tokens. Stable for a page session (it's built from the live `soundMap` once prebake finishes).
3. **User message, per request:**
   - tempo;
   - the whole buffer with `/*<sel>*/…/*</sel>*/` around the selection;
   - the instruction, or "none. Offer varied, musically interesting directions.";
   - the buffer's current eval error, if there is one;
   - on a retry, the rejected code plus the feedback and "Return exactly one option.";
   - for the parallel strategy, a direction hint.

**Why:**
- The whole buffer gives the model context (key, tempo, other parts, sounds already in use), and the sentinels say exactly what to replace.
- The rules ask for code that replaces only the marked text, keeps its role and form, and has no trailing `,`/`;`. `postprocess.ts` enforces that anyway: it strips echoed sentinels and trailing separators and clips labels to 4 words.
- The "distinct directions" list (rhythm, texture/timbre, pitch/harmony, structure over time, space) plus "options that differ only in a number are not distinct" stops four `gain` tweaks.
- Instructions asking to remove or mute something allow a silent option; anything else must make sound.

**The reference** (`npm run build:reference`, ~4.3k tokens):
- It reads the JSDoc of the installed `@strudel/core`, `tonal`, `codemirror` (slider), `webaudio` (scope) and `draw` (pianoroll) packages. It keeps a curated list of 93 names in 11 groups, each of which must exist in the live scope (tested). Nine entries whose JSDoc is missing or not attached where the parser looks (`struct`, `mask`, `every`, `setcps`/`setcpm`, `._scope`/`._pianoroll`, …) are written by hand in the builder.
- Examples are only kept for functions whose call shape isn't obvious (callbacks, chord and scale strings), because each costs about 15 tokens.
- The hand-written mini-notation rules and 8 full examples (`scripts/reference-extras.md`) are evaluated in the Sandbox by the tests.
- **Surprise:** chars/4 underestimates this text badly. The first version, "~4.8k tokens" by that estimate, was 7.5k real tokens (`npm run count:prompt` uses the free count_tokens endpoint), and the full sound list was 4.4k. Code and short names tokenize at about 2.1 characters per token, so both were cut.

**The sound summary** (`src/soundSummary.ts`) groups the 1650 names into:
- the common drums;
- the synth waveforms;
- 12 well-known drum machines with their exact sounds;
- the other banks by name (aliases such as `tr909`/`rolandtr909` folded into the longer name);
- General MIDI instruments;
- the other plain names;
- the multi-sample instrument families as `name_*`.

A test checks that every loaded sound is findable from it.

### Caching

Every request after the first reads ~7.3k of its ~7.8k input tokens from the cache (eval: 7266–7648 cache-read tokens per request). For Haiku that makes a request cost about $0.0002–0.0003 instead of ~$0.0009. In the browser the status line shows it: `tokens 5.4k in (5.3k cached) / 180 out · $0.0002` (before the reference was trimmed).

## Validation changes

- **Buffer baseline.** `Validator.baseline(buffer)` checks the unmodified buffer once per request, as the first job in the worker's validation queue. If it fails, any option that fails with the *same* error (same stage and message, line:col ignored) is checked **alone**: the buffer's top-level `setcps`/`setcpm` lines plus the option, judged by its own events.
  - It passes → kept, with a "checked alone" badge (its tooltip warns that auditioning plays the whole buffer, which may fail).
  - It fails the same way alone → dropped as `buffer error`, without a retry.
  - It fails in its own way → the normal retry.
  - The status line shows `buffer has an error: …`.
  - Verified in Chrome: with `.wobble(2)` added to the kick line, ⌘K on the hi-hat line gave 4 cards, all "checked alone". Auditioning one made the card `failed` (the live repl evaluates the spliced, still broken buffer), and the original kept playing. That is the behaviour agreed for this milestone.
- **Silent options are retried.** An option that validates with an `empty` or `unknown-sample` warning gets one retry with app-written feedback:
  - "This option produces no sound. Return a variation that still plays."
  - "`zzzz` is not a loaded sound. Use only loaded sounds, for example: bd sd hh oh cp rim lt mt."
  - If the replacement still warns, it's kept with its badge. If the replacement fails outright, the slot falls back to the original warned option rather than ending empty.
- **The exception:** `empty` is not retried when the instruction asks for silence.
  - `SILENCE_WORDS = drop, mute, silence, silent, remove, stop, cut, out`, matched as whole words with inflections (dropped, muting, cutting, …), so "lower the cutoff", "output", "less busy" and "droplets" don't count. Tested in `test/baseline.test.ts`.
  - Verified in Chrome: Claude with "drop the hats" returned `s("hh*8").mask("0").gain(0.6)` and kept it with its `empty` badge, without a retry. The faulty mock with `faultKind = 'empty'` and no instruction had all four retried and replaced.
- **Feedback reads as instructions** (`src/feedback.ts`), e.g. "This code has a syntax error (Unexpected token (2:5)). Return valid Strudel code: check brackets, quotes and mini-notation." or "`wobble` is not a Strudel function here. Use only functions from the reference." A test checks that every message contains "Return", "Use" or "Suggest" and doesn't start with a log-style `reason:` prefix.

## Widgets during audition: hold back the dispatch

**Choice:** while an audition evaluates, a transaction filter (`holdEffects`) strips the `setSliderWidgets` and `addWidget` effects that StrudelMirror's `afterEval` dispatches. The editor keeps the widgets of its own text. Evaluating the original (0/Esc, commit, or the user's Ctrl+Enter) dispatches them normally.

**Why not map positions by the splice delta:**
- Widgets inside the option have no editor position to map to.
- Block widget DOM ids are index-based (`getWidgetID` → `_widget__scope_<index>`), so the editor's existing scope canvas already shows the auditioned pattern.
- Re-placing decorations on every swap would rebuild widget DOM, including the scope canvases, at each key press.

**Sliders need one more step:**
- A slider's id is `slider_<position in the evaluated code>`. Dragging one edits the text and posts the id from its last editor evaluation.
- During an audition the pattern reads the slider under its position in the *spliced* code, so a drag would have no effect on sliders after the selection.
- `editorSliderField` tracks the editor's sliders through edits, `sliderIdMap` translates editor ids to audition ids, and `main.ts` mirrors `cm-slider` messages onto the audition id while an option plays.

**Verified in Chrome** with sliders before, inside and after the selection, and a `._scope()` after the selection (run A) or inside it (run B):
- During every audition, the widget DOM stayed at its editor positions, although the auditioned code's widget metadata had moved (e.g. the bass slider at 154 instead of 145, the scope at 179 instead of 170).
- After returning to the original, the widgets were in place.
- Dragging the bass slider during an audition set `sliderValues.slider_154` (the audition id) to the dragged value, and the tray didn't go stale (the edit is outside the range).
- Tests: the filter and the slider field against a real `EditorState`, and `sliderIdMap` against the transpiler's own widget ids.

## Provider switching and status

- **Choosing the provider:** `?provider=mock|claude&model=claude-haiku-5-5|claude-sonnet-5-5`; the header select; Alt+P cycles mock → Haiku → Sonnet. Switching updates the URL (`replaceState`) and applies to the next request; R regenerates with it. There is no automatic fallback: an API error stays in the status line.
- **Optional settings:** `&effort=low|medium|high&thinking=off|adaptive&strategy=single|parallel&warmup=0`. Unset means the server's per-model defaults.
- **Status line:** `provider: claude · haiku-5-5 · first 998 ms · last 1.8 s · 4 ok · 0 retried · 0 dropped · validation 3.2 ms avg / 4.8 ms max · tokens 7.8k in (5.4k cached) / 252 out · $0.0005 · …`, plus the error and `buffer has an error: …` in red.

## Eval harness

- **Run it:** `npm run eval -- --provider claude --model claude-haiku-5-5 [--thinking off|adaptive] [--effort low|medium|high] [--strategy parallel] [--warmup] [--only id,id] [--label name]`. It writes `eval/reports/<time>-<label>.json` and `.md`. Needs the key; about $0.006 per Haiku run and $0.10 per Sonnet run.
- **Fixtures** (`eval/fixtures.json`): 20 requests over 5 buffers (drums, bass, chords, melody, effects). Each buffer is tested to evaluate with loaded sounds, and each selection to evaluate on its own. The instructions are 5 empty, 12 musical ("busier in the second half", "call and response with the kick", "darker", "half-time feel", …) and 3 asking for silence.
- **What it runs:** the browser's own path. `RemoteProvider` is wired straight to the proxy app (`app.request`, no network or rate limit), then `runRequest` and the real `Validator`, over the Sandbox in a `worker_threads` worker so `WorkerBackend`'s 250 ms pre-emption works. TypeScript loads through a Vite module runner (`eval/vite-runner.mjs`) with the tests' `@kabelsalat/web` alias.
- **Timing:** "first card" is the first validated option, measured from the request's start, so validation is included.
- **Listening:** `http://localhost:5173/eval/listen.html` (dev server). Pick a report, then N/P to step through requests, 1–4 to audition (beat-quantized, as in the tray), 0 for the original. Rate each option and add a note; notes are kept per report in localStorage and exported as JSON.

### Results (20 requests each, 2026-10-15, one run per config)

| Model | Thinking | Effort | First card p50 / p90 / max | First card ≤ 2 s | Last slot p50 | Pass rate, first attempt | Requests with ≥ 3 cards | Cost / request |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku 5.5 | off (`disabled`) | low | **1.28 / 2.38 / 2.40 s** | **17/20** | 2.20 s | 97% (67/69) | 19/20 | $0.0003 |
| Haiku 5.5 | off | medium | 1.25 / 1.44 / 2.19 s | 19/20 | 2.04 s | 91% (61/67) | 18/20 | $0.0002 |
| Haiku 5.5 | adaptive (default) | medium (default) | 4.26 / 7.83 / 8.66 s | 0/20 | 6.02 s | 92% (66/72) | 19/20 | $0.0007 |
| Sonnet 5.5 | off (`between_tools`) | low | **1.57 / 1.85 / 2.12 s** | **19/20** | 3.10 s | 100% (75/75) | 19/20 | $0.0055 |
| Sonnet 5.5 | off | medium | 1.71 / 2.22 / 2.26 s | 18/20 | 3.34 s | 100% (78/78) | 20/20 | $0.0047 |
| Sonnet 5.5 | adaptive (default) | high (default) | 2.43 / 7.31 / 7.34 s | 6/20 | 4.74 s | 96% (77/80) | 20/20 | $0.0073 |

- **Thinking decides the latency.** With adaptive thinking (each model's default), the first card misses 2 s on most requests and p90 is over 7 s. With thinking off, both models meet the 2 s target on 17–19 of 20 requests.
- The first-attempt pass rate is 91–100% for every config. Retries were for `eval` (unknown functions), `query`, `empty` and `unknown-sample`; no slot was dropped for good except one duplicate.
- **Defaults chosen** (`server/providers/models.ts`): thinking off, effort low, for both models. For Haiku, low gives a better pass rate than medium (97% vs 91%) at the same latency and cost. For Sonnet, low is slightly faster at the same pass rate.
- Haiku often returns 3 options rather than 4 (69 of 80 slots); Sonnet nearly always returns 4.
- "Last slot settled" is 2–3 s because Haiku writes 3–4 options of ~70 output tokens each after the first, and retries add 1–2 s. The first card is the number the 2 s target is about.
- An earlier sweep had silently run all three Haiku configs at the defaults (a shell quoting mistake). Its two 460 s / 940 s stalls led to the idle timeout. Those reports were deleted.

### One request vs. four in parallel

`--strategy parallel` (or `?strategy=parallel`): four one-option calls at once, each with a different direction hint (rhythm and groove / texture and timbre / pitch and harmony or structure / space and movement or structure). Thinking off, effort low:

| Model | Strategy | First card p50 / p90 / max | ≤ 2 s | Last slot p50 | Pass rate, first attempt | Cards shown | Cost / request |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku 5.5 | single | 1.28 / 2.38 / 2.40 s | 17/20 | 2.20 s | 97% | 69/80 | $0.0003 |
| Haiku 5.5 | parallel | **0.99 / 1.10 / 1.12 s** | **20/20** | 1.57 s | 91% | 78/80 | $0.0008 |
| Sonnet 5.5 | single | 1.57 / 1.85 / 2.12 s | 19/20 | 3.10 s | 100% | 75/80 | $0.0055 |
| Sonnet 5.5 | parallel | 1.54 / 1.91 / 2.11 s | 19/20 | 2.22 s | 95% | 80/80 | $0.0091 |

- **Parallel Haiku is the fastest config measured:** every first card in under 1.2 s, the last slot settled almost a second sooner, and always 4 options. It costs 2.7× as much (still under a tenth of a cent), and the pass rate dropped to 91%. Most of those retries were duplicates: the four calls can't see each other, so on silence requests several returned the same `s("hh*8").gain(0)`.
- Sonnet barely gains on the first card (each call still pays Sonnet's time to first token) but always fills 4 slots.
- **The default stays `single`**, as the brief asks: it meets the target on 17/20 (Haiku) and 19/20 (Sonnet) requests at the lowest cost, and one call per ⌘K keeps the rate limit simple. Parallel is one URL parameter away and would be the choice if the 2 s target is made strict.

### Warm-up

The question is whether a warm-up request after the first user gesture saves the first real request the grammar compile and the prompt-cache write. A cold grammar was forced by giving the schema a never-used top-level key (`--schema-key`; a structural change also invalidates the prompt cache). Two trials, three requests each:

| Trial | First request (cold), no warm-up | First request after a warm-up | Warm-up itself |
| --- | --- | --- | --- |
| 1 | 1.76 s | 1.93 s | 2.14 s |
| 2 | 2.40 s | 1.59 s | 2.06 s |
| Steady state (sweep p50) | 1.28 s | | |

- **The compile costs little here.** A cold first request was 0.5–1.1 s slower than the steady state; with a warm-up first it was 0.3–0.7 s slower. With two trials, that difference is within the noise; I can't claim the warm-up saves a measurable amount of latency.
- **It does move the cache write** (~7.3k tokens, about $0.0009 on Haiku, $0.018 on Sonnet) off the first ⌘K. In ordinary use the page is open for more than 2 s before the first ⌘K, so the warm-up has finished by then.
- **It stays on by default** because it is cheap and can't hurt. `?warmup=0` turns it off. In the browser it is sent with the selected model and settings, so it warms the right cache.
- Seen in the browser: pressing ⌘K right after load, while the warm-up was still in flight, meant both requests wrote the cache (`cacheWrite: 5251` on both). The warm-up only helps when it finishes first.

## Listening checklist (milestone 4)

Use headphones. Run `npm run dev` with the key in `.env`, open `/?provider=claude`, press ⌘K → Esc, then Ctrl+Enter.

- [ ] ⌘K on the hi-hat line, Enter (no instruction). Cards start appearing within about 1.5 s; the status line shows `provider: claude · haiku-5-5`, first/last times, and `tokens … (… cached)` with a cost. Every card plays. The four sound different from each other (rhythm vs. sound vs. space), not just louder/softer.
- [ ] ⌘K on the bass line with `darker`. Every option is darker (filter, octave, sound) and stays in key with the rest.
- [ ] ⌘K on the kick with `call and response with the kick`, `half-time feel`, then `busier in the second half`. Each card follows the instruction, and changes land on the beat as before.
- [ ] ⌘K on the hi-hat line with `drop the hats`. A silent card may appear with an `empty` badge, and it isn't retried.
- [ ] Press R while cards are arriving: they reset, and the proxy terminal logs `aborted`. Same for a new ⌘K, and for Esc twice.
- [ ] Audition a card, Enter: the line changes, one ⌘Z restores it.
- [ ] Add `.wobble(2)` to the kick line (don't evaluate), ⌘K on the hi-hat line: cards show `checked alone`, and the status line says `buffer has an error: s(...).wobble is not a function`. Auditioning one marks it failed; the original keeps playing. Remove `.wobble(2)` again.
- [ ] Alt+P to Sonnet, ⌘K on the bass line: cards take a little longer and cost more (status line). Alt+P to mock: the old mock options, offline.
- [ ] Put `.gain(slider(0.6, 0, 1))` on the hi-hat line and `._scope()` on the bass line, Ctrl+Enter, ⌘K on the hi-hat line, audition cards: the slider and scope don't move. Drag the bass line's slider while an option plays: it still changes the sound.
- [ ] Set a wrong key in `.env`, restart `npm run dev`, ⌘K: the status line says the key was rejected, and the mock is **not** used instead.
- [ ] `/eval/listen.html`: pick the Haiku report, N/P through requests, 1–4 to audition. Rate a few cards; Export notes downloads them.

## Open problems

- **"Checked alone" cards can't be heard** while the buffer is broken: auditioning evaluates the whole spliced buffer, which fails. That is the behaviour agreed for this milestone. An "audition alone" mode (only the option plus tempo) would make them audible.
- **Two `._scope()` widgets in one buffer render wrongly** even without auditioning: the second canvas lands in the wrong place and the line it belongs to looks empty. Strudel's `BlockWidget.eq()` always returns `true` (`@strudel/codemirror/widget.mjs`), so CodeMirror reuses one widget's DOM for another. Upstream; one scope per buffer works.
- **An option that adds a `._scope()` before an existing one** shifts the block widget indexes, so during the audition the existing canvas shows the new scope. Visual only, and it resets on returning to the original.
- **Haiku often returns 3 options**, not 4 (69/80 slots), even though the prompt asks for "3 or 4". The parallel strategy always fills 4.
- **Retries cost a full prompt each** (cached, so ~$0.0002 on Haiku), and count against the per-minute limit; a ⌘K with four retries uses five of the 20 calls.
- **Quality isn't measured by the pass rate.** Cards that validate can still be musically odd: Sonnet once gave `s("bd*4(5,8,1)")`, and Haiku `x.rarely()` with no function, which validates as a no-op. Use the listening page and its ratings for that.
- **The sound summary lists only 12 drum machines in full.** For the other ~60 banks the model knows the names but not their sounds, so `.bank("casiovl1")` with `oh` comes back as an `unknown-sample` retry.
- **`src/generated/scope.json` and `sounds.json` are snapshots.** After a Strudel upgrade, run `await __shaper.saveScope()` in the dev page, then `npm run build:reference`; the reference test fails until the checked-in reference matches.
- **The eval measures from the proxy app in-process**, so browser → proxy network time isn't included. Locally that is about 1 ms; the browser numbers seen in testing (first card 1.0–1.6 s) match.
- **`silence()` was in the first reference** as if it were a function (it's a value), and parallel Haiku used it twice on "mute the pad" (`silence is not a function`, then retried). The reference now has a hand-written `silence` entry, and the signals (`sine`, `saw`, `rand`, …) are listed as values (`sine.range(…)`), not as `sine()`; a test checks it. The sweeps above ran before that fix.

---

# Milestone 5 notes: fix modes on Claude

⌘J (minimal fix) and ⌘⇧J (intent rewrite) now go to the selected provider through the same `Provider` → `RemoteProvider` → NDJSON path as shape mode. Before this they were always answered by the mock. Checked in Chrome on macOS against `npm run dev` (keys via the Claude in Chrome extension). `npm test` (408 tests), `npm run build` and `npm run check:key` pass. No test calls the real API.

## Where Strudel's errors point

Measured with the real transpiler and sandbox in `test/fixTarget.test.ts`, with the starter's hi-hat line broken:

| Broken as | Stage | Message | Position |
| --- | --- | --- | --- |
| `.gian(0.6)` | eval | `s(...).gian is not a function` | none. The name is searched for |
| `"hh*8["` | syntax | `[mini] parse error at line 4: …` | line only |
| missing `"` | syntax | `Unterminated string constant (4:4)` | line:col (col is the opening quote) |
| missing `)` | syntax | `Unexpected token (6:1)` | **two lines below**: the closing line of `stack(`. Lezer's error node is at the same place |
| `silence()`, `sine()` | eval | `silence is not a function` | none. The name is searched for |
| `.euclid(8, 3)` | eval | `Invalid array length` | none, and no name |
| `.fast("double")` | query | `Invalid argument` | none |
| `.scale("D:dorain")`, `chord("Hmaj7")`, `s(0.4).gain("hh*8")` | — | runs, but the line makes no sound | — |
| `chord("<Cm7 Fxx>")`, `.lpf("x", 800)`, `.gain("loud")` | — | plays (at least partly) | not detected |

Runtime errors carry no position because `core.evaluate` runs the *transpiled* code through `Function()`, so stacks point into generated code.

## What ⌘J / ⌘⇧J operate on (`src/fixTarget.ts`)

`diagnoseFix` runs only on the key press. It takes a few ms in the worker. In order:

1. **The current buffer's baseline.** If that passes, it uses the live repl's last eval error, but only while the editor text equals the code of that failed outside eval.
2. **Locating the error** (`src/errorPosition.ts`):
   - `(L:C)` gives a position;
   - `at line N` gives a line;
   - for "X is not a function / defined", the unique occurrence of `X` outside strings and comments.
   - **Syntax errors walk up** from the reported line to the first line that doesn't transpile on its own. They skip lines like `)` or `stack(`, and lines that start with `.`. This is what finds the missing `)` two lines above `(6:1)`.
3. **Choosing the target with no selection:**
   - a runtime error with a position → `captureAt(pos)`, the same syntax-tree logic as ⌘K;
   - a syntax error → the whole trimmed line (the tree is unreliable there);
   - no position → the cursor's expression, then each line's expression, checked alone, until one fails with the same error. Otherwise the result is `unknown`.
4. **With a selection:** the error is inside it if its position is inside, or (with no position) if the selection alone fails the same way.
   - If the error is outside, the selection is checked alone. If it's broken in its own way, that is what gets fixed, with `otherErrors` set so options are judged alone.
   - Otherwise the result is `outside`.
5. **When the buffer runs,** the target is still broken if it makes no sound. That means 0 onsets, or onsets with no playable sound key (`s(0.4)`). Unknown sounds count too.

**What the keys do with the result:**
- ⌘J on `ok`: the status line says **"nothing to fix: this code runs"** and no request is sent (checked: 0 fetches to `/api/options` with the cursor on a line, on line 1, and with a selection).
- ⌘J on `outside`: "the error is on line N, outside the selection: …".
- ⌘J on `unknown`: "can't tell where the error is (…). Select the broken code and press ⌘J."
- ⌘⇧J always runs, including on working code. On `outside`, it rewrites the selection judged alone. **Changed from the plan:** the instruction box opens after the diagnosis rather than during it, because the box is placed at the diagnosed range.

## Request and prompt

- `OptionRequest` gained `errorAt?: { line?, inSelection, otherError? }`. Otherwise the shape is unchanged: `mode` and `error` are filled in.
- **`ROLE` now has three sections** (shape, fix-minimal, fix-rewrite) under shared rules. All stay in the cached system block, so every mode shares one prompt cache.
  - Minimal fix: 1 option, 2 only if genuinely ambiguous; change as little as possible and keep every musical choice; "values such as sine are not functions"; the label names the fix.
  - Rewrite: 3–4 interpretations, restructuring allowed, follow the instruction.
- **The user message** starts with `Mode: …`. In fix modes it adds "Problem in the marked code: <error> (buffer line N, line n of the marked code)", or that the error is outside the selection, plus any other error to leave alone. A minimal fix has no instruction line.
- **Cost:** the role grew from about 800 to 1,345 tokens, so system block 1 went from about 5.1k to 5.68k tokens (`npm run count:prompt`). It is cached.
- **Proxy limits:** at most 2 options for `fix-minimal`, 4 for the others. Fix modes ignore `strategy=parallel`.

## Validation in fix modes (`Validator.validate(…, { fix })`)

- **The fix test:** the option spliced into the **whole buffer** must transpile, evaluate and query, and make sound.
  - Milestone 4's "same error as the buffer → checked alone / `buffer`" path is not used. There is no baseline in fix modes.
- **The new reason `unfixed`:** the option still fails with the original error (positions ignored), or the original was silent and the option is still silent. Label "still broken". One retry with "This still fails with: <error>. Return code that fixes this error."
- **Judged alone** (`checked alone` badge): when the buffer has another error outside the selection, or when the spliced buffer fails with a *new* error located outside the option.
- `identical` and `duplicate` still apply. The sounds-identical check is skipped, since the original doesn't evaluate.
- **A rewrite of working code** is validated like shape mode, with the baseline and the fingerprint.
- **Change size** = characters inserted plus deleted (`diffChars`). It is reported per card.

## Tray

- **Character diffs:** minimal-fix cards diff by character. Each change is a solid coloured block, so a single `"` or `)` stands out. Whitespace-only changes show as `·` / `⏎`. More than 12 changed runs falls back to the word diff.
- **Card 0** reads **"original (broken)"** when the original doesn't evaluate. The unused second minimal-fix slot is hidden.
- **0/Esc on a broken original:**
  - When the tray opens, `snapshotPlaying` stores `quantizer.playing()` (the pattern that is or will be playing) and the cps; a stopped clock stores `silence`.
  - 0, Esc and a live `evalFailed` emit `restoreSnapshot`. It runs through the evaluation queue: `Quantizer.swapTo(snapshot)`, then `drawer.invalidate`. So the return lands on the beat like any swap.
  - A regenerate keeps the snapshot it has.
  - If the original still evaluates (a silent selection, a rewrite of working code), 0/Esc re-evaluate the editor as before.
- **Commit** is unchanged: the fix is written in one transaction and the editor is evaluated, which now succeeds. One ⌘Z restores the broken original.
- **Status line:** `fixing: <error> (line N) · provider: claude · <model that answered> · …`.

**Verified in Chrome**, starter buffer, hi-hat line broken 8 ways (`gian`, `"hh*8[`, missing `"`, missing `)`, `silence()`, `sine()`, `euclid(8, 3)`, `fast("double")`), cursor on line 1:
- every ⌘J produced a working fix with a visible char diff (e.g. `del:[`, `ins:)`, `del:( del:)`);
- no card failed live;
- every audition and every return landed on a quarter cycle, with the clock anchor kept;
- 0 restored the *same pattern object* that played before ⌘J;
- the clock kept running throughout.

With a selection, the same 8 plus the scale typo and swapped `s`/`gain` arguments also gave working fixes. Enter committed, and one ⌘Z restored `s("hh*8".gain(0.6)` exactly.

## "Sounds identical" check (all modes except fix)

- **How it works:** the worker hashes every onset over `FINGERPRINT_CYCLES = 8` cycles, plus the tempo after evaluation (so a `setcps`-only change counts as different).
  - Each onset contributes its whole span, plus its value as canonical JSON (sorted keys, Fractions as n/d, numbers to 1e-9, locations left out). The list is sorted and hashed with cyrb53.
  - `baseline()` hashes the original buffer once per request.
  - An option whose spliced buffer hashes the same is dropped as `identical` (`identicalBy: 'sound'`), labelled "sounds the same", with feedback "This option sounds exactly like the original. Change the sound."
  - It is skipped when the baseline fails, for checked-alone options, and in fix modes.
- **Randomness is deterministic.** `degradeBy`, `sometimes`, `rand`, `irand`, `shuffle` and `choose` hash the same across evaluations: Strudel seeds them from cycle time. `Math.random()` in user code hashes differently every time, so such an option is never taken for the original.
- **Tests:**
  - Caught: `.fast(1)`, `.sometimesBy(0.5, x => x)`, `.rarely(x => x)`, `.rev()` on a uniform pattern, the same events written out, `gain("0.6")`.
  - Kept: `.degradeBy(0.5)` / `(0.3)`, `.sometimes(x => x.speed(2))`, a change only in the 4th cycle, a `<…>` mask, `.slow(4)`, a tempo change.
  - **`.rarely()` with no function** isn't a no-op in Strudel 1.2.6: it silences the line (0 onsets), so it is caught as `empty` instead.
  - The same results hold in the browser through the worker, at 2–6 ms per check.
- **Cost:** about 2× a 2-cycle check (in-process median):

  | Buffer | 2 cycles | 8 cycles + hash |
  | --- | --- | --- |
  | starter | 0.40 ms | 0.82 ms |
  | effects | 0.69 ms | 1.74 ms |
  | heavy (`hh*32` with rand, sometimes, ply, plus a 16-note `off`/`jux`) | 3.0 ms | 12.0 ms |

  All far under the 250 ms limit.
- **What it catches in practice:** adding a number to a control pattern (`.add("<0 0 0 12>")` after `.scale`, even `.add(7)` before it) is a **no-op**: the engine returns identical events.
  - Haiku shape re-run: 1 option caught and retried.
  - Re-checking the cards milestone 4 *shipped*: Haiku 2/69, Haiku parallel 1/78, Sonnet 0/75.
  - The mock's own `.rev()` on `bd*4` / `hh*8` is caught too (8 times in the 30-request pipeline soak).

## Fix eval (`npm run eval -- --mode fix`, 2026-10-16, thinking off, effort low)

15 fixtures (`eval/fixtures.json`):
- **11 minimal fixes:** misspelled method, mini bracket, missing quote, missing paren, argument type, argument order, `sine()`, `silence()`, scale typo, silent selection, and an error outside a broken selection. 6 use only a cursor.
- **4 rewrite sketches:** a bass that should follow the chords (working code, with an instruction), a nested-array arpeggio, `euclid(3)`, and chord names passed to `note` (with an instruction).

Requests are built by `diagnoseFix`, the browser's own code; a test checks that every fixture diagnoses as stated.

| Run | Fix rate | First-try fix rate | First card p50 / p90 / max | Minimal change size p50 / p90 / max | Rewrite cards | Cost / request |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku 5.5, run 1 | **15/15** | 14/15 | 1.26 / 3.92 / 6.29 s | 2 / 9 / 18 | 11/16 | $0.00021 |
| Haiku 5.5, run 2 | 14/15 | 13/15 | 1.26 / 2.48 / 2.71 s | 2 / 9 / 18 | 12/16 | $0.00015 |
| Sonnet 5.5 | **15/15** | **15/15** | 1.56 / 2.12 / 2.12 s | 2 / 9 / 18 | **16/16** | $0.00372 |
| Haiku, rewrites only ×2 | 4/4, 4/4 | 2/4, 4/4 | 2.18 / 1.35 s p50 | — | 10/16, 13/16 | $0.0002 |
| Sonnet, rewrites only ×2 | 4/4, 4/4 | 4/4, 4/4 | 1.65 / 1.33 s p50 | — | 16/16, 16/16 | $0.0044 |

- **Minimal fixes are the same from both models.** All 11 changes were character-for-character equal: `gain not gian` (2), `close the quote` (1), `remove stray bracket` (1), `swap euclid args` (4), `double is 2` (9), `sine is a value` (2), `dorian not dorain` (2), `swap s and gain` (18). Every model returned exactly one option, never the optional second.
- **Haiku's latency outliers** (6.3 s, 3.9 s) wrote only ~40 output tokens: that is time to first token on the API side. The second run had none over 2.7 s.
- **Rewrites differ:**
  - Sonnet returned 4 working interpretations on the first try in all 12 rewrite requests.
  - Haiku returned 2–4. In one run it kept the broken `note("Cm7 Fm7")` in all four options of `rewrite-chord-names`, so every card was silent. That led to the rule "still silent when the original was silent → `unfixed`"; with it, the reruns fixed all four sketches.
- **`LARGE_CHANGE_CHARS = 20`.** The 33 working minimal fixes across three runs changed 1–9 characters (p90 9), except the argument swap at 18. The 94 rewrite cards changed 6 (p10) / 30 (p50) / 65 (p90) characters. 20 sits above every real minimal fix and below most rewrites.

**Recommendation, implemented:**
- **Minimal fix → Haiku 5.5.** Same fixes as Sonnet, at about 1/18 of the cost, with a faster p50.
- **Rewrite → Sonnet 5.5.** It always fills four working cards on the first try, for about $0.004 per request.

How it works:
- The proxy picks the model when the browser doesn't name one: `MODE_DEFAULT_MODELS` in `server/providers/models.ts`.
- `?fixModel=` / `?rewriteModel=` override it; ⌘K still uses the header select.
- The `done` line echoes the model, so the status line shows which one answered.
- Verified in the browser: ⌘⇧J on working hats (no instruction, and "make it swing") and on a sketch bass line (`note([...]).s(sawtooth)`, without an instruction and with "a bouncy bassline") each gave 4 working Sonnet cards. The page sent no model.

## Shape re-run (Haiku 5.5, thinking off, effort low, after the prompt change)

| Run | First card p50 / p90 / max | ≤ 2 s | Pass rate, first attempt | Cards shown | Cost / request |
| --- | --- | --- | --- | --- | --- |
| M4 (2026-10-15) | 1.28 / 2.38 / 2.40 s | 17/20 | 97% (67/69) | 69/80 | $0.0003 |
| M5 (2026-10-16) | 1.59 / 2.03 / 2.15 s | 17/20 | 96% (68/71) | 70/80 | $0.00024 |

The sounds-identical check caught **1** option: `melody-empty`, `.add("<0 0 0 12>")` after `.scale`. It was retried and replaced. The p50 rose by 0.3 s and p90 fell, with one run each; part of that may be the larger prompt.

## Listening checklist (milestone 5)

Use headphones. Run `npm run dev`, open `/?provider=claude`, then Ctrl+Enter.

- [ ] Delete the `)` after `"hh*8"` (don't evaluate). The music keeps playing the last good pattern. Put the cursor on line 1 and press ⌘J. Within about 1.5 s: card 0 "original (broken)", card 1 with a green `)` block, and the status line "fixing: Unexpected token (6:1) (line 4)".
- [ ] Press `1`: the fix lands on the beat (the hats sound the same as before you broke them). Press `0`: the last good pattern comes back on the beat, not the fix. Press `1` then Enter: the line is fixed and the editor evaluates. One ⌘Z restores the broken line.
- [ ] Repeat with `.gian(0.6)`, `"hh*8[`, a missing `"`, `silence()` in place of the hats, `.gain(sine())`, `.euclid(8, 3)` and `.fast("double")`, both with the cursor elsewhere and with the line selected. Each gives a small, exact char diff.
- [ ] ⌘J on the unbroken starter, anywhere: the status line says "nothing to fix: this code runs" and the proxy logs no request.
- [ ] Select the hats and break the kick line (`.gian(2)`) too: ⌘J says "the error is on line 3, outside the selection". With the hats also broken (`.fast("double")`), ⌘J fixes the hats with a `checked alone` badge.
- [ ] ⌘⇧J on the working hats, Enter (no instruction): 4 rewrites, and the status line says `sonnet-5-5`. Again with "make it swing".
- [ ] Turn the bass into `note(["c2", "eb2", ["g2", "bb2"]]).s(sawtooth)`, select it, ⌘⇧J with and without "a bouncy bassline": 4 working interpretations each, with word diffs.
- [ ] ⌘K on the melody with no instruction several times. If a card would play exactly the original (an `.add(n)` after `.scale`), it never appears: the slot shows `retrying… (sounds the same)`.
- [ ] `/eval/listen.html`, choose a `fix-…` report: card 0 reads "original (broken)", minimal fixes show char diffs and their size, and 0 doesn't evaluate the broken buffer.

## Open problems

- **The warm-up only warms the selected model.** The first ⌘⇧J of a session on Sonnet paid the cache write in the browser ($0.0232 for that request; $0.0034 once cached). Warming Sonnet on every page load would cost about $0.02 even when ⌘⇧J is never used.
- **Partly broken code isn't diagnosed:** a bad chord name inside `<…>` (the other chords play), `.lpf("x", 800)`, `.gain("loud")`. ⌘J says "nothing to fix".
- **Some live errors are only logged.** A scale typo logs `Scale name D dorain is incomplete` on every scheduler tick live, while the worker's query just returns 0 onsets. Diagnosis catches it as silent, but the console fills up until it's fixed.
- **The second minimal-fix slot was never used** in the eval (all 33 minimal-fix requests across three runs returned 1 option). It stays hidden unless filled.
- **Rewrites of working code** are validated like shape mode, so a rewrite that sounds exactly like the original is retried. That's arguably right for "rewrite", but untested by ear.
- **Seen once and not reproduced:** while two scripted test runs overlapped in the same page, the clock stopped (`[cyclist] stop`) with no app code running. In a clean run of all 8 broken-line cases, the clock never stopped.
- **The reference doesn't warn** that `.add(number)` on `n()`/`note()` patterns does nothing. The sounds-identical check catches it after the fact, at the cost of a retry.

---

# New idea: generate mode

A beginner who clears the editor, or doesn't know what to write, gets a **✨ New idea** button. It opens the instruction box; an empty submit gives four varied starting points, and notes ("chill lofi beat") give four takes on them. The options arrive in the normal tray: 1–4 audition, Enter keeps one, which fills the editor.

## How it works

- **When it shows:** `noRunnableCode(text)` (`src/generate.ts`): empty, whitespace, or only `//` / `/* */` comments. The centred button over the editor shows when that holds and there is no tray, request or open box. The narrow-screen action bar has a `generate` button, disabled when there is code or a tray. Both follow every edit (an update listener), not just tray events.
- **⌘K** on such a buffer does the same as the button. With code, ⌘K is unchanged.
- **Box:** the same `InstructionBox` and history, with its own placeholder ("describe a vibe, or just press Enter"; `open(range, submit, placeholder)`). On an empty range it anchors below line 1; on a comments-only buffer, below the last comment line.
- **Capture:** the whole buffer, `0…length`. **Comments are replaced, not kept:** the model sees them inside the markers and the prompt tells it to treat them as notes, like an instruction. One ⌘Z brings them back.
- **Request:** `mode: 'generate'` through `Provider` → `RemoteProvider` → NDJSON → proxy, like the fix modes. 4 slots (`slotCount`); always one call (the parallel strategy's direction hints are shape-only).
- **Prompt:** a `## Mode: generate` section in the cached `ROLE`. Complete 3–10-line programs that play at once; beginner-readable (common functions, one `stack` of 2–4 layers, no variables); four genuinely different ideas without an instruction, four takes with one; comments are notes; labels name the idea. Two shared rules gained a generate exception: the selection's "role and form" is a whole program, and setting the tempo is allowed. User message: `Instruction: none. Offer four different starting ideas.`
  - **Cost:** role and rules **1,541 → 1,967 tokens (+426)**; system block 1 **6,031 → 6,457** (`npm run count:prompt`). Cached, so it costs on every cache write and as cache reads.
- **Validation:** the pipeline skips the baseline for generate, as it does for fix modes (there is no original to sound like), so no fingerprint and no "sounds identical" check. The `empty` and `unknown-sample` retries still apply. Returning the comments unchanged is still `identical` by text.
- **Model:** **Sonnet 5.5** (`MODE_DEFAULT_MODELS.generate`; Gemini 4 argon). `?generateModel=` overrides it. Reasoning: this is a beginner's first impression, and it happens once per idea, not on every tweak. Rewrite (the closest task: four whole interpretations) needed Sonnet to fill four working cards on the first try, while Haiku often returns 3 (open problem 3). Latency is less critical than for shape, since cards stream in and the user then listens for a while. One browser request (2026-10-23, cache warm): first card 2.3 s, last 6.1 s, 771 output tokens, $0.0089, 4/4 ready first try. Not yet measured: Haiku on the generate fixtures. Run both and compare.
- **Mock:** six short beginner programs (`IDEAS` in `src/mockProvider.ts`), matching instruction words first ("lofi", "acid", "ambient"…); a replacement is an idea not offered yet; faults break the planned program. Each idea is checked in the sandbox in `test/generate.test.ts`.

## Auditioning with nothing playing

The beginner has probably never pressed Play, and an empty buffer has nothing to play.
- The tray uses the **snapshot** path that broken-code fixes use: `restoresSnapshot` is true for generate. When the tray opens, `snapshotPlaying` records what is playing (silence on a stopped clock) and whether the clock was running.
- Pressing 1–4 auditions with `repl.evaluate`, which **autostarts the clock**, so the first press makes sound with no Play. `getAudioContext().resume()` runs first when the clock is stopped; the keypress or click is the user gesture.
- **0 / Esc** (and a live `evalFailed`) restore the snapshot through the quantizer, on the beat. If the clock was stopped when the tray opened, it is **stopped again once that swap lands**, unless something was evaluated since. This now also applies to fix modes opened on a stopped clock (before, the clock kept running silence).
- **Enter** writes the option in one `isolateHistory.of('full')` transaction, with the cursor at the start (not a whole-buffer selection that the next keypress would replace), and evaluates the editor. The status line then says "Your idea is playing. Select a line and press ⌘/Ctrl+K (or tap Shape) to shape it." until the next edit.
- Card 0 reads **"nothing"** ("empty editor", or the comments); options show their code, not a diff against nothing.

## Verified (2026-10-23)

- `npm test` (489), `npm run build`, `npm run check:key` pass.
- **Mock, headless Chrome (muted), 1280 px and 390 px:** clear → button (or action-bar button) → box → Enter → 4 cards → 1, 2 (clock starts from stopped, onsets queued) → Esc/Original (clock stopped, editor empty) → 3 → Enter/Accept (editor filled, cursor at 0, hint shown) → ⌘Z (empty again, button back). ⌘K on empty opens the generate box; on `// comment` the button stays; typing code hides it; ⌘K with code opens the shape box. Comments plus "chill" gave lofi and ambient first.
- **`?provider=claude`:** one request as above. Esc after auditioning all four stopped the clock.
- **Not verified:** by ear (runs were muted), on a real phone/touch device, Safari/Firefox, and the generate eval (paid, not run).

## Open problems

- **Undo after a commit leaves the idea playing** with an empty editor (as any undo does in Strudel; nothing re-evaluates). Press Stop.
- **The first New idea of a session pays the Sonnet cache write** (see live problem 2). Warming Sonnet when the page opens on an empty buffer would fix it, but the starter code isn't empty, so it rarely applies.
- **The starter code hides the feature:** a new user sees the starter and only finds New idea after clearing it. Not changed (out of scope); worth deciding.
- **Beginner readability is only prompted, not checked.** The one real run had `lpf(sine.range(400,1200).slow(8))`, `swingBy(1/3, 4)` and a bad chord note (`bd3` inside `[g2,bd3,d3]`, which still plays partly; see live problem 5).
- **Gemini generate** was not exercised.

