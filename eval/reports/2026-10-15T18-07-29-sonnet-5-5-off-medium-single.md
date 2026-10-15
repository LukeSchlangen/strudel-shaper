### sonnet-5-5-off-medium-single (2026-10-15 18:07)

Config: {"provider":"claude","model":"claude-sonnet-5-5","effort":"medium","thinking":"off"}. Prompt: reference ~2414 tok, sounds ~1053 tok.

| Metric | p50 | p90 | max | ≤ 2 s |
| --- | --- | --- | --- | --- |
| First option from the provider | 1.70 s | 2.21 s | 2.25 s | 18/20 |
| **First card shown** (validated) | 1.71 s | 2.22 s | 2.26 s | 18/20 |
| Last slot settled (retries incl.) | 3.34 s | 4.05 s | 4.06 s | 0/20 |

- **Pass rate, first attempt** (validated with no warning and no retry): 78/78 (100%)
- **Cards shown**: 78/80 slots (78 options offered first; 20/20 requests ended with ≥ 3 cards)
- Retries by reason: none
- Drops by reason: none
- Warnings on shown cards: none
- Errors: none
- Tokens per request: 7834 in (7648 cache reads), 355 out; 1.00 calls
- **Cost per request**: $0.00469 (total $0.0938)
