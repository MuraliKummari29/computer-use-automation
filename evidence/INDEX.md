# Evidence index

Each directory holds `run.jsonl` (structured, redacted log), `step-NN.png` screenshots, `result.json`, and on failure
`failure.png` + `trace.zip` (`npx playwright show-trace <file>`). Handoffs add `intervention-N.json`.

## Discovery (real LLM-driven runs)

- [discovery-20260911T041205Z-7ff9](discovery-20260911T041205Z-7ff9/): transcript.json, capability.json, screenshots, run.jsonl

## Replay (deterministic, no model)

| Scenario | Result | Evidence |
|---|---|---|
| replay: success (harbor) | `success` | [replay-20260912T193200Z-406d](replay-20260912T193200Z-406d/) |
| replay: business outcome MEMBER_NOT_FOUND | `business_outcome` | [replay-20260912T193201Z-b59a](replay-20260912T193201Z-b59a/) |
| replay: recoverable interstitial + session expiry | `success` | [replay-20260912T193202Z-2dd9](replay-20260912T193202Z-2dd9/) |
| replay: second tenant via overrides (summit) | `success` | [replay-20260912T193206Z-b1ab](replay-20260912T193206Z-b1ab/) |
| replay: validation rejected (business outcome) | `business_outcome` | [replay-20260912T193207Z-5d03](replay-20260912T193207Z-5d03/) |
| replay: hard failure APP_ERROR with trace | `failure` | [replay-20260912T193212Z-a679](replay-20260912T193212Z-a679/) |
| replay: permission denied (business outcome, block_card) | `business_outcome` | [replay-20260912T193218Z-7358](replay-20260912T193218Z-7358/) |
| replay: irreversible step escalated to human, approved, completed | `success` | [replay-20260912T193220Z-00c2](replay-20260912T193220Z-00c2/) |
