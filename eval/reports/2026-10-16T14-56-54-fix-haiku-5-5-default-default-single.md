### fix-haiku-5-5-default-default-single (2026-10-16 14:56)

Config: {"provider":"claude","model":"claude-haiku-5-5","mode":"fix"}. Prompt: reference ~2438 tok, sounds ~1053 tok.

| Metric | p50 | p90 | max | ≤ 2 s |
| --- | --- | --- | --- | --- |
| First option from the provider | 1.25 s | 3.91 s | 6.28 s | 11/15 |
| **First card shown** (validated) | 1.26 s | 3.92 s | 6.29 s | 11/15 |
| Last slot settled (retries incl.) | 1.80 s | 3.92 s | 6.29 s | 10/15 |

- **Pass rate, first attempt** (validated with no warning and no retry): 22/23 (96%)
- **Cards shown**: 22/38 slots (23 options offered first; 3/15 requests ended with ≥ 3 cards)
- Retries by reason: query 1
- Drops by reason: query 1
- Warnings on shown cards: none
- Errors: none
- Tokens per request: 8433 in (7682 cache reads), 97 out; 1.00 calls
- **Cost per request**: $0.00021 (total $0.0032)
- Sounds the same as the original (fingerprint): 0 retried or dropped

- **Fix rate** (≥ 1 card that works in the whole buffer and sounds): 15/15
- **First-try fix rate** (card 1, first attempt, no retry): 14/15
- **Change size of minimal fixes** (characters): p50 2 · p90 9 · max 18 (11 cards)
- Requests not sent: 0

| Request | Mode | Diagnosis | Cards | First card | Change | Retries |
| --- | --- | --- | --- | --- | --- | --- |
| fix-misspelled | fix-minimal | eval | 1/2 | gian is gain: `s("hh*8").gain(0.6)` | 2 |  |
| fix-mini-bracket | fix-minimal | syntax | 1/2 | close bracket: `s("hh*8").gain(0.6)` | 1 |  |
| fix-missing-quote | fix-minimal | syntax | 1/2 | close string quote: `s("hh*8").gain(0.6)` | 1 |  |
| fix-missing-paren | fix-minimal | syntax | 1/2 | close bracket: `s("hh*8").gain(0.6)` | 1 |  |
| fix-arg-type | fix-minimal | query | 1/2 | fast needs number: `s("hh*8").fast(2).gain(0.6)` | 9 |  |
| fix-arg-order | fix-minimal | eval | 1/2 | euclid args order: `s("hh").euclid(3, 8).gain(0.5)` | 4 |  |
| fix-signal-call | fix-minimal | eval | 1/2 | sine is a value: `s("hh*16").gain(".6 .3").pan(sine.fast(2))` | 2 |  |
| fix-silence-call | fix-minimal | eval | 1/2 | silence is a value: `silence` | 2 |  |
| fix-scale-name | fix-minimal | silent | 1/2 | dorian typo: `n("0 2 4 <5 7> 4 2 0 ~").scale("D:dorian").s("square").lpf(1800).gain(0.5)` | 2 |  |
| fix-silent-selection | fix-minimal | silent | 1/2 | quote the sound name: `s("hh*8").gain(0.4)` | 18 |  |
| fix-error-elsewhere | fix-minimal | query + other | 1/2 | double is a number: `s("hh*8").fast(2).gain(0.5)` | 9 |  |
| rewrite-bass-chords | fix-rewrite | ok | 2/4 | root octave bass: `chord("<Cm7 Fm7 Bb7 Ebmaj7>").rootNotes(2).note().s("sawtooth").lpf(600).gain(0.8)` |  | query |
| rewrite-arp | fix-rewrite | silent | 3/4 | stacked chord pad: `n("[0,2,4] [5,7]").scale("D:dorian").s("square").lpf(1800).gain(0.5).slow(2)` |  |  |
| rewrite-euclid | fix-rewrite | eval | 3/4 | euclid 3 of 8: `s("cp").euclid(3, 8).gain(0.4)` |  |  |
| rewrite-chord-names | fix-rewrite | silent | 3/4 | short chord stabs: `chord("<Cm7 Fm7>").voicing().s("gm_epiano1").struct("x ~ ~ x ~ ~ x ~").attack(0.005).release(0.2).room(0.3)` |  |  |
