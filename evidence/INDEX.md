# Evidence index

Each directory holds `run.jsonl` (structured, redacted log), `step-NN.png` screenshots, `result.json`, and on failure
`failure.png` + `trace.zip` (`npx playwright show-trace <file>`). Handoffs add `intervention-N.json`.

## Discovery (real LLM-driven runs)

- [discovery-20260911T041205Z-7ff9](discovery-20260911T041205Z-7ff9/): transcript.json, capability.json, screenshots, run.jsonl

## Replay (deterministic, no model)

| Scenario | Result | Evidence |
|---|---|---|
| replay: success (harbor) | `success` | [replay-20260911T041253Z-d96f](replay-20260911T041253Z-d96f/) |
| replay: business outcome MEMBER_NOT_FOUND | `business_outcome` | [replay-20260911T041255Z-753b](replay-20260911T041255Z-753b/) |
| replay: recoverable interstitial + session expiry | `success` | [replay-20260911T041256Z-a08a](replay-20260911T041256Z-a08a/) |
| replay: second tenant via overrides (summit) | `success` | [replay-20260911T041300Z-efbb](replay-20260911T041300Z-efbb/) |
| replay: validation rejected (business outcome) | `business_outcome` | [replay-20260911T041301Z-8005](replay-20260911T041301Z-8005/) |
| replay: hard failure APP_ERROR with trace | `failure` | [replay-20260911T041306Z-71cf](replay-20260911T041306Z-71cf/) |
| replay: permission denied (business outcome, block_card) | `business_outcome` | [replay-20260911T041312Z-f542](replay-20260911T041312Z-f542/) |
| replay: irreversible step escalated to human, approved, completed | `success` | [replay-20260911T041314Z-6af2](replay-20260911T041314Z-6af2/) |
