### haiku-5-5-off-medium-single (2026-10-15 18:03)

Config: {"provider":"claude","model":"claude-haiku-5-5","effort":"medium","thinking":"off"}. Prompt: reference ~2414 tok, sounds ~1053 tok.

| Metric | p50 | p90 | max | ≤ 2 s |
| --- | --- | --- | --- | --- |
| First option from the provider | 1.18 s | 1.43 s | 1.43 s | 20/20 |
| **First card shown** (validated) | 1.25 s | 1.44 s | 2.19 s | 19/20 |
| Last slot settled (retries incl.) | 2.04 s | 3.11 s | 3.80 s | 9/20 |

- **Pass rate, first attempt** (validated with no warning and no retry): 61/67 (91%)
- **Cards shown**: 67/80 slots (67 options offered first; 18/20 requests ended with ≥ 3 cards)
- Retries by reason: eval 3, query 2, empty 1
- Drops by reason: none
- Warnings on shown cards: empty 1
- Errors: none
- Tokens per request: 7834 in (7648 cache reads), 278 out; 1.00 calls
- **Cost per request**: $0.00023 (total $0.0047)
