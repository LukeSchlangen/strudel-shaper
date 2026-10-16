### fix-sonnet-5-5-default-default-single (2026-10-16 14:57)

Config: {"provider":"claude","model":"claude-sonnet-5-5","mode":"fix"}. Prompt: reference ~2438 tok, sounds ~1053 tok.

| Metric | p50 | p90 | max | ≤ 2 s |
| --- | --- | --- | --- | --- |
| First option from the provider | 1.55 s | 2.11 s | 2.11 s | 12/15 |
| **First card shown** (validated) | 1.56 s | 2.12 s | 2.12 s | 12/15 |
| Last slot settled (retries incl.) | 1.64 s | 3.09 s | 3.30 s | 9/15 |

- **Pass rate, first attempt** (validated with no warning and no retry): 27/27 (100%)
- **Cards shown**: 27/38 slots (27 options offered first; 4/15 requests ended with ≥ 3 cards)
- Retries by reason: none
- Drops by reason: none
- Warnings on shown cards: none
- Errors: none
- Tokens per request: 8433 in (7682 cache reads), 118 out; 1.00 calls
- **Cost per request**: $0.00372 (total $0.0559)
- Sounds the same as the original (fingerprint): 0 retried or dropped

- **Fix rate** (≥ 1 card that works in the whole buffer and sounds): 15/15
- **First-try fix rate** (card 1, first attempt, no retry): 15/15
- **Change size of minimal fixes** (characters): p50 2 · p90 9 · max 18 (11 cards)
- Requests not sent: 0

| Request | Mode | Diagnosis | Cards | First card | Change | Retries |
| --- | --- | --- | --- | --- | --- | --- |
| fix-misspelled | fix-minimal | eval | 1/2 | gain not gian: `s("hh*8").gain(0.6)` | 2 |  |
| fix-mini-bracket | fix-minimal | syntax | 1/2 | remove stray bracket: `s("hh*8").gain(0.6)` | 1 |  |
| fix-missing-quote | fix-minimal | syntax | 1/2 | close the quote: `s("hh*8").gain(0.6)` | 1 |  |
| fix-missing-paren | fix-minimal | syntax | 1/2 | move bracket: `s("hh*8").gain(0.6)` | 1 |  |
| fix-arg-type | fix-minimal | query | 1/2 | double is 2: `s("hh*8").fast(2).gain(0.6)` | 9 |  |
| fix-arg-order | fix-minimal | eval | 1/2 | swap euclid args: `s("hh").euclid(3, 8).gain(0.5)` | 4 |  |
| fix-signal-call | fix-minimal | eval | 1/2 | sine is a value: `s("hh*16").gain(".6 .3").pan(sine.fast(2))` | 2 |  |
| fix-silence-call | fix-minimal | eval | 1/2 | silence is a value: `silence` | 2 |  |
| fix-scale-name | fix-minimal | silent | 1/2 | dorian not dorain: `n("0 2 4 <5 7> 4 2 0 ~").scale("D:dorian").s("square").lpf(1800).gain(0.5)` | 2 |  |
| fix-silent-selection | fix-minimal | silent | 1/2 | swap s and gain: `s("hh*8").gain(0.4)` | 18 |  |
| fix-error-elsewhere | fix-minimal | query + other | 1/2 | double is 2: `s("hh*8").fast(2).gain(0.5)` | 9 |  |
| rewrite-bass-chords | fix-rewrite | ok | 4/4 | root notes whole: `"<Cm7 Fm7 Bb7 Ebmaj7>".rootNotes(2).note().s("triangle").gain(0.8)` |  |  |
| rewrite-arp | fix-rewrite | silent | 4/4 | mini-notation melody: `n("0 2 4 [5 7]").scale("D:dorian").s("square").lpf(1800).gain(0.5)` |  |  |
| rewrite-euclid | fix-rewrite | eval | 4/4 | euclid 3 of 8: `s("cp").euclid(3, 8).gain(0.4)` |  |  |
| rewrite-chord-names | fix-rewrite | silent | 4/4 | offbeat stabs: `chord("<Cm7 Fm7>").voicing().struct("~ x ~ x").s("gm_epiano1").release(0.15).room(0.3)` |  |  |
