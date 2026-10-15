### haiku-5-5-off-low-single (2026-10-15 18:02)

Config: {"provider":"claude","model":"claude-haiku-5-5","effort":"low","thinking":"off"}. Prompt: reference ~2414 tok, sounds ~1053 tok.

| Metric | p50 | p90 | max | ≤ 2 s |
| --- | --- | --- | --- | --- |
| First option from the provider | 1.25 s | 1.78 s | 2.37 s | 19/20 |
| **First card shown** (validated) | 1.28 s | 2.38 s | 2.40 s | 17/20 |
| Last slot settled (retries incl.) | 2.20 s | 2.88 s | 4.67 s | 8/20 |

- **Pass rate, first attempt** (validated with no warning and no retry): 67/69 (97%)
- **Cards shown**: 69/80 slots (69 options offered first; 19/20 requests ended with ≥ 3 cards)
- Retries by reason: query 1, eval 1
- Drops by reason: none
- Warnings on shown cards: empty 1
- Errors: none
- Tokens per request: 7834 in (7266 cache reads), 289 out; 1.00 calls
- **Cost per request**: $0.00028 (total $0.0057)
