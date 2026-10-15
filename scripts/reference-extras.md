## Mini-notation (inside "…" strings)
- Spaces divide one cycle into equal steps: `"bd sd bd sd"`. `~` or `-` is a rest.
- `[a b]` fits a group into one step: `"bd [sd sd]"`. `,` inside brackets plays layers at once: `"[bd, hh hh]"`.
- `<a b c>` plays one item per cycle, in turn: `"<c e g>"`. Combine: `"bd <sd [sd sd]>"`.
- `a*3` repeats within the step, `a/2` stretches over 2 cycles, `a!3` repeats as separate steps, `a@3` makes a step 3 times longer, `_` extends the previous step.
- `a?` drops it at random (50%), `a?0.2` with 20% chance. `a|b` picks one at random each cycle.
- `a(3,8)` is a euclidean rhythm: 3 hits spread over 8 steps; `a(3,8,2)` rotates by 2.
- `a:2` picks sample number 2 of a sound (`"hh:3"`), same as `.n(2)`.
- Notes: `note("c3 eb3 g3")`, numbers are MIDI (`note("48 51")`), `n("0 2 4").scale("C:minor")` uses scale degrees.
- `{a b c}%4` plays a sequence at 4 steps per cycle (polymeter).

## Writing good variations
- A drum line stays a drum line: change the rhythm, the sounds (`.bank("tr808")`), the dynamics (`.gain("[.8 .4]*4")`) or add motion (`.sometimesBy(.3, x => x.speed(2))`).
- A bass or melody keeps its key: transform with `.scale`, `.transpose`, `.off`, `.arp`, octave changes, or rewrite the notes in the same scale.
- Patterns of arguments make movement: `.lpf(sine.range(300, 2000).slow(4))`, `.pan(rand)`, `.gain(perlin.range(.4, .9))`.
- Prefer musical ideas over parameter tweaks: call and response, half-time, fills on the last cycle (`.lastOf(4, x => x.fast(2))`), ghost notes, polyrhythms (`"bd(3,8), hh(5,8)"`).

## Examples
```js
s("bd*2, ~ sd, hh*8").bank("tr909")
s("bd(3,8), ~ cp, [~ hh]*4").gain("1 .8")
note("<c2 c2 eb2 g1>*2").s("sawtooth").lpf(sine.range(300, 1500).slow(8)).lpq(8)
n("0 2 4 <6 7>").scale("C:minor").s("triangle").room(.4)
chord("<Cm7 Fm7 G7 Cm7>").voicing().s("gm_epiano1").attack(.05).release(.5)
s("hh*16").gain(".8 .4 .6 .4").sometimesBy(.2, x => x.speed(1.5)).pan(sine)
note("c4 eb4 g4 bb4").fast(2).off(1/8, x => x.add(note(12)).gain(.5)).s("square").lpf(1200)
s("bd sd").every(4, x => x.fast(2)).jux(rev)
```
