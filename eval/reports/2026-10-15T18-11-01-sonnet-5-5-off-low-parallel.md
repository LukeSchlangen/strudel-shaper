### sonnet-5-5-off-low-parallel (2026-10-15 18:11)

Config: {"provider":"claude","model":"claude-sonnet-5-5","effort":"low","thinking":"off","strategy":"parallel"}. Prompt: reference ~2414 tok, sounds ~1053 tok.

| Metric | p50 | p90 | max | ≤ 2 s |
| --- | --- | --- | --- | --- |
| First option from the provider | 1.53 s | 1.89 s | 2.10 s | 19/20 |
| **First card shown** (validated) | 1.54 s | 1.91 s | 2.11 s | 19/20 |
| Last slot settled (retries incl.) | 2.22 s | 3.48 s | 3.62 s | 8/20 |

- **Pass rate, first attempt** (validated with no warning and no retry): 76/80 (95%)
- **Cards shown**: 80/80 slots (80 options offered first; 20/20 requests ended with ≥ 3 cards)
- Retries by reason: duplicate 4
- Drops by reason: none
- Warnings on shown cards: empty 1
- Errors: none
- Tokens per request: 31461 in (30592 cache reads), 428 out; 1.00 calls
- **Cost per request**: $0.00907 (total $0.1815)
