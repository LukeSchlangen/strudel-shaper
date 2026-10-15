### sonnet-5-5-off-low-single (2026-10-15 18:06)

Config: {"provider":"claude","model":"claude-sonnet-5-5","effort":"low","thinking":"off"}. Prompt: reference ~2414 tok, sounds ~1053 tok.

| Metric | p50 | p90 | max | ≤ 2 s |
| --- | --- | --- | --- | --- |
| First option from the provider | 1.56 s | 1.84 s | 2.11 s | 19/20 |
| **First card shown** (validated) | 1.57 s | 1.85 s | 2.12 s | 19/20 |
| Last slot settled (retries incl.) | 3.10 s | 4.01 s | 4.11 s | 3/20 |

- **Pass rate, first attempt** (validated with no warning and no retry): 75/75 (100%)
- **Cards shown**: 75/80 slots (75 options offered first; 19/20 requests ended with ≥ 3 cards)
- Retries by reason: none
- Drops by reason: none
- Warnings on shown cards: none
- Errors: none
- Tokens per request: 7834 in (7266 cache reads), 340 out; 1.00 calls
- **Cost per request**: $0.00546 (total $0.1092)
