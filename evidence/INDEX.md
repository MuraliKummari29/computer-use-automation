# Evidence index

Each directory holds `run.jsonl` (structured, redacted log), `step-NN.png` screenshots, `result.json`, and on failure
`failure.png` + `trace.zip` (`npx playwright show-trace <file>`). Handoffs add `intervention-N.json`.

## Discovery (real LLM-driven runs)

- [discovery-20260911T041205Z-7ff9](discovery-20260911T041205Z-7ff9/): transcript.json, capability.json, screenshots, run.jsonl

## Replay (deterministic, no model)

| Scenario | Result | Evidence |
|---|---|---|
| replay: success (harbor) | `success` | [replay-20260912T194457Z-ff34](replay-20260912T194457Z-ff34/) |
| replay: business outcome MEMBER_NOT_FOUND | `business_outcome` | [replay-20260912T194459Z-1e08](replay-20260912T194459Z-1e08/) |
| replay: recoverable interstitial + session expiry | `success` | [replay-20260912T194501Z-fa2c](replay-20260912T194501Z-fa2c/) |
| replay: second tenant via overrides (summit) | `success` | [replay-20260912T194504Z-dab5](replay-20260912T194504Z-dab5/) |
| replay: validation rejected (business outcome) | `business_outcome` | [replay-20260912T194506Z-6b34](replay-20260912T194506Z-6b34/) |
| replay: hard failure APP_ERROR with trace | `failure` | [replay-20260912T194511Z-86f7](replay-20260912T194511Z-86f7/) |
| replay: permission denied (business outcome, block_card) | `business_outcome` | [replay-20260912T194517Z-1a6a](replay-20260912T194517Z-1a6a/) |
| replay: slow commit -> IRREVERSIBLE_OUTCOME_UNKNOWN escalated, never re-sent, operator aborts | `failure` | [replay-20260912T194519Z-bc76](replay-20260912T194519Z-bc76/) |
| replay: irreversible step escalated to human, approved, completed | `success` | [replay-20260912T194532Z-3c07](replay-20260912T194532Z-3c07/) |
