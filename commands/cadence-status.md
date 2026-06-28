---
description: Cadence — read-only ledger status + progress dashboard
allowed-tools: Bash, Read
---

# /cadence-status — where the loop stands (read-only)

- Ledger digest: !`node .cadence/lib/ledger.mjs show 2>/dev/null || echo "not adopted — run /cadence init \"<goal>\""`
- Next item: !`node .cadence/lib/ledger.mjs next 2>/dev/null || true`

Summarize the digest and the next item for the user — what shipped, what's pending (top score first),
and anything `blockedOnOwner`. **Do not mutate the ledger.**

Point them at the self-contained dashboard `.cadence/cadence-overview.html`, and offer to
(re)generate/open it with `node .cadence/lib/overview.mjs --open`. Then suggest `/cadence tick` to act
on the next item, or `/cadence start` to run the loop.
