### sonnet-5-5-adaptive-high-single (2026-10-15 18:09)

Config: {"provider":"claude","model":"claude-sonnet-5-5","effort":"high","thinking":"adaptive"}. Prompt: reference ~2414 tok, sounds ~1053 tok.

| Metric | p50 | p90 | max | ≤ 2 s |
| --- | --- | --- | --- | --- |
| First option from the provider | 2.42 s | 7.30 s | 7.32 s | 7/20 |
| **First card shown** (validated) | 2.43 s | 7.31 s | 7.34 s | 6/20 |
| Last slot settled (retries incl.) | 4.74 s | 8.66 s | 9.25 s | 0/20 |

- **Pass rate, first attempt** (validated with no warning and no retry): 77/80 (96%)
- **Cards shown**: 79/80 slots (80 options offered first; 20/20 requests ended with ≥ 3 cards)
- Retries by reason: unknown-sample 2, eval 1
- Drops by reason: duplicate 1
- Warnings on shown cards: empty 2
- Errors: none
- Tokens per request: 7835 in (7267 cache reads), 521 out; 1.00 calls
- **Cost per request**: $0.00727 (total $0.1453)
