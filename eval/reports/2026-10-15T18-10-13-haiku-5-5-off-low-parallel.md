### haiku-5-5-off-low-parallel (2026-10-15 18:10)

Config: {"provider":"claude","model":"claude-haiku-5-5","effort":"low","thinking":"off","strategy":"parallel"}. Prompt: reference ~2414 tok, sounds ~1053 tok.

| Metric | p50 | p90 | max | ≤ 2 s |
| --- | --- | --- | --- | --- |
| First option from the provider | 0.98 s | 1.09 s | 1.10 s | 20/20 |
| **First card shown** (validated) | 0.99 s | 1.10 s | 1.12 s | 20/20 |
| Last slot settled (retries incl.) | 1.57 s | 2.61 s | 2.62 s | 13/20 |

- **Pass rate, first attempt** (validated with no warning and no retry): 73/80 (91%)
- **Cards shown**: 78/80 slots (80 options offered first; 20/20 requests ended with ≥ 3 cards)
- Retries by reason: duplicate 3, eval 3, unknown-sample 1
- Drops by reason: query 1, duplicate 1
- Warnings on shown cards: empty 3
- Errors: none
- Tokens per request: 31461 in (29062 cache reads), 366 out; 1.00 calls
- **Cost per request**: $0.00075 (total $0.0150)
