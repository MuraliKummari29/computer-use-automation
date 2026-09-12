# Evidence index

Each directory holds `run.jsonl` (structured, redacted log), `step-NN.png` screenshots, `result.json`, and on failure
`failure.png` + `trace.zip` (`npx playwright show-trace <file>`). Handoffs add `intervention-N.json`.

## Discovery (real LLM-driven runs)

- [discovery-20260912T205126Z-1f36](discovery-20260912T205126Z-1f36/): transcript.json, capability.json, screenshots, run.jsonl

## Replay (deterministic, no model)

| Scenario | Result | Evidence |
|---|---|---|
| replay: success (harbor) | `success` | [replay-20260912T205227Z-c5b4](replay-20260912T205227Z-c5b4/) |
| replay: business outcome MEMBER_NOT_FOUND | `business_outcome` | [replay-20260912T205229Z-bbb3](replay-20260912T205229Z-bbb3/) |
| replay: recoverable interstitial + session expiry | `success` | [replay-20260912T205231Z-9208](replay-20260912T205231Z-9208/) |
| replay: second tenant via overrides (summit) | `success` | [replay-20260912T205234Z-4069](replay-20260912T205234Z-4069/) |
| replay: validation rejected (business outcome) | `business_outcome` | [replay-20260912T205236Z-2446](replay-20260912T205236Z-2446/) |
| replay: hard failure APP_ERROR with trace | `failure` | [replay-20260912T205241Z-da44](replay-20260912T205241Z-da44/) |
| replay: permission denied (business outcome, block_card) | `business_outcome` | [replay-20260912T205246Z-df92](replay-20260912T205246Z-df92/) |
| replay: slow commit -> IRREVERSIBLE_OUTCOME_UNKNOWN escalated, never re-sent, operator aborts | `failure` | [replay-20260912T205248Z-11c6](replay-20260912T205248Z-11c6/) |
| replay: irreversible step escalated to human, approved, completed | `success` | [replay-20260912T205310Z-58a0](replay-20260912T205310Z-58a0/) |
