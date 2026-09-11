# Evidence index

Each directory holds `run.jsonl` (structured, redacted log), `step-NN.png` screenshots, `result.json`, and on failure
`failure.png` + `trace.zip` (`npx playwright show-trace <file>`). Handoffs add `intervention-N.json`.

## Discovery (real LLM-driven runs)

- [discovery-20260911T024953Z-013b](discovery-20260911T024953Z-013b/): transcript.json, capability.json, screenshots, run.jsonl

## Replay (deterministic, no model)

| Scenario | Result | Evidence |
|---|---|---|
| replay: success (harbor) | `success` | [replay-20260911T031705Z-3a89](replay-20260911T031705Z-3a89/) |
| replay: business outcome MEMBER_NOT_FOUND | `business_outcome` | [replay-20260911T031706Z-2003](replay-20260911T031706Z-2003/) |
| replay: recoverable interstitial + session expiry | `success` | [replay-20260911T031707Z-c098](replay-20260911T031707Z-c098/) |
| replay: second tenant via overrides (summit) | `success` | [replay-20260911T031711Z-9b25](replay-20260911T031711Z-9b25/) |
| replay: validation rejected (business outcome) | `business_outcome` | [replay-20260911T031712Z-54c7](replay-20260911T031712Z-54c7/) |
| replay: hard failure APP_ERROR with trace | `failure` | [replay-20260911T031718Z-9e4d](replay-20260911T031718Z-9e4d/) |
| replay: permission denied (business outcome, block_card) | `business_outcome` | [replay-20260911T031723Z-dd59](replay-20260911T031723Z-dd59/) |
| replay: irreversible step escalated to human, approved, completed | `success` | [replay-20260911T031725Z-aa3e](replay-20260911T031725Z-aa3e/) |
