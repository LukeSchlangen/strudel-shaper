### haiku-5-5-adaptive-medium-single (2026-10-15 18:05)

Config: {"provider":"claude","model":"claude-haiku-5-5","effort":"medium","thinking":"adaptive"}. Prompt: reference ~2414 tok, sounds ~1053 tok.

| Metric | p50 | p90 | max | ≤ 2 s |
| --- | --- | --- | --- | --- |
| First option from the provider | 4.25 s | 7.82 s | 8.65 s | 0/20 |
| **First card shown** (validated) | 4.26 s | 7.83 s | 8.66 s | 0/20 |
| Last slot settled (retries incl.) | 6.02 s | 8.35 s | 9.13 s | 0/20 |

- **Pass rate, first attempt** (validated with no warning and no retry): 66/72 (92%)
- **Cards shown**: 71/80 slots (72 options offered first; 19/20 requests ended with ≥ 3 cards)
- Retries by reason: eval 4, query 2
- Drops by reason: duplicate 1
- Warnings on shown cards: empty 4
- Errors: none
- Tokens per request: 7835 in (7267 cache reads), 1049 out; 1.00 calls
- **Cost per request**: $0.00066 (total $0.0133)
