# CoreServ Computer-Use Automation

A small, end-to-end computer-use system for the "no API" case in bank back-office software:

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the AI agent invokes it in production.

- **Discovery**: Claude drives a legacy, frameset-based core-banking console from screenshots with numbered marks, one action per turn, under a policy allowlist.
- **Artifact**: the successful run becomes a typed, versioned `Capability` (params, outputs, steps with locator bundles, checkpoints, error detectors, per-tenant overrides).
- **Replay**: the capability runs with no model in the loop, classifies runtime conditions into *business outcome / recoverable / hard failure / escalate*, and returns a structured result.
- **Handoff**: when stuck, the run pauses, a human takes the live browser session, acts, and hands control back; everything they did is recorded.

The design write-up is in [REPORT.md](REPORT.md). Evidence from real runs is in [`evidence/`](evidence/).

## Layout

```
mock-app/        CoreServ: the target. A deliberately legacy console (framesets, table layout, no ids) with
                 two tenant configs and injectable runtime faults.
src/schema/      The contracts: Capability artifact, ReplayResult, Policy (Zod; JSON Schema exported to schema/)
src/surface/     The Surface seam (observe/act/resolve) + the Playwright implementation (set-of-marks, locator bundles)
src/agent/       Discovery loop (Claude), prompts, recorder (actions -> artifact steps)
src/replay/      Deterministic replay engine: detect -> resolve -> policy -> act -> verify
src/apps/        App profile for the vendor product: shared error detectors, dialog rules
src/handoff/     Control token state machine, operator console (HTTP), scripted operator (tests)
src/policy/      Allowlist guard + redaction
src/evidence/    Per-run evidence directories (jsonl log, screenshots, trace, result)
policies/        coreserv.json: origins, paths, action types, irreversible matchers, redaction patterns
capabilities/    Saved capabilities (the catalog)
tests/           vitest: schema/guard/redaction units, replay integration incl. faults and handoff, offline discovery
```

## Setup

Requirements: Node 20+ (developed on 24). No other services.

```bash
npm install
npx playwright install chromium
cp .env.example .env        # only needed for discovery; add ANTHROPIC_API_KEY
```

The mock console uses synthetic operator credentials (`operator` / `demo123`) that the CLI reads from
`CORESERV_USER` / `CORESERV_PASSWORD` and defaults if unset. They are never written to artifacts or logs.

## Run without live services

Everything except discovery works offline:

```bash
npm test                 # ~6 min: 37 tests, headless Chromium against the mock app (ports 4310/4311); also runs in CI
npm run app              # start the target console at http://localhost:4310 (tenant "harbor")
npm run app:summit       # a second tenant of the same product at http://localhost:4311
```

## Demo path

Terminal 1, start the target:

```bash
npm run app
```

Terminal 2, discover (real LLM run; needs `ANTHROPIC_API_KEY`):

```bash
npm run discover -- \
  --goal "Look up member 10001 and read their current savings and checking balances and the member's name" \
  --param memberNumber=10001 --sensitive memberNumber \
  --out capabilities/coreserv.member.read_balances.json
```

This prints the model's turns, writes the capability, and saves `evidence/discovery-<runId>/` (redacted transcript,
per-step screenshots, jsonl log). Add `--headed` to watch, `--operator` to allow the agent to escalate to you. The agent's replay of a fresh draft
needs `--allow-draft` until you have reviewed and approved it.

Replay the artifact with a different member, no model involved:

```bash
npm run replay -- --capability capabilities/coreserv.member.read_balances.json --param memberNumber=10003
```

Replay that hits exceptional states (the `--fault` flag injects a runtime condition into the mock app; the engine
does not know which one):

```bash
# expected business outcome, not a crash
npm run replay -- --capability capabilities/coreserv.member.read_balances.json --param memberNumber=99999
# recoverable: interstitial notice / slow load / session expiry (re-authenticates and restarts)
npm run replay -- --capability capabilities/coreserv.member.read_balances.json --param memberNumber=10001 --fault interstitial
npm run replay -- --capability capabilities/coreserv.member.read_balances.json --param memberNumber=10001 --fault session_expired
# second tenant, same artifact, per-tenant override (label "Account #" + compliance interstitial)
npm run app:summit   # in another terminal
npm run replay -- --capability capabilities/coreserv.member.read_balances.json --param memberNumber=10042 --tenant summit
```

The write flow (irreversible step, approval-gated). Approval is a decision record, not a flag: who approved and
why, recorded in the result and the evidence. Each command is written out in full so it works in any shell:

```bash
# POLICY_BLOCKED: the commit step needs approval and no operator is attached
npm run replay -- --capability capabilities/coreserv.member.open_subaccount.json \
  --param memberNumber=10001 --param product=CLUB --param nickname=Vacation --param initialDeposit=50
# success: returns confirmationNumber + newShareId
npm run replay -- --capability capabilities/coreserv.member.open_subaccount.json \
  --param memberNumber=10001 --param product=CLUB --param nickname=Vacation --param initialDeposit=50 \
  --approved-by "jane.doe" --approval-reason "member verified by phone, ticket 4821"
# VALIDATION_REJECTED (business outcome): deposit below the product minimum
npm run replay -- --capability capabilities/coreserv.member.open_subaccount.json \
  --param memberNumber=10001 --param product=CLUB --param nickname=Vacation --param initialDeposit=5 \
  --approved-by "jane.doe" --approval-reason "demo"
# APP_ERROR hard failure with failure.png + trace.zip
npm run replay -- --capability capabilities/coreserv.member.open_subaccount.json \
  --param memberNumber=10001 --param product=CLUB --param nickname=Vacation --param initialDeposit=50 \
  --approved-by "jane.doe" --approval-reason "demo" --fault app_error
# IRREVERSIBLE_OUTCOME_UNKNOWN: the commit takes effect but the response is slow; the engine never re-sends it
npm run replay -- --capability capabilities/coreserv.member.open_subaccount.json \
  --param memberNumber=10042 --param product=SAV2 --param nickname=Slow --param initialDeposit=10 \
  --approved-by "jane.doe" --approval-reason "demo" --fault slow_commit
```

Capabilities with `status: draft` are refused by `replay` and `catalog` unless `--allow-draft` is passed; the
review step is to read the artifact and flip the status.

Human-in-the-loop, for real: run headed with the operator console attached, then answer the request at
http://localhost:4400 (take control, act in the browser window, hand back with retry/skip/approve/abort):

```bash
# the commit step escalates for approval
npm run replay -- --capability capabilities/coreserv.member.open_subaccount.json \
  --param memberNumber=10001 --param product=CLUB --param nickname=Vacation --param initialDeposit=50 --headed --operator
# an unexpected native dialog escalates; take control, click Continue yourself, hand back with Skip
npm run replay -- --capability capabilities/coreserv.member.open_subaccount.json \
  --param memberNumber=10001 --param product=CLUB --param nickname=Vacation --param initialDeposit=50 --headed --operator --fault confirm_dialog
```

Agent-facing catalog (stretch goal): list saved capabilities as tool definitions, or invoke one by id:

```bash
npm run catalog
npm run catalog -- --invoke coreserv.member.read_balances --param memberNumber=10001
```

Regenerate the replay evidence set: `npm run evidence`. Export the JSON Schemas: `npm run schemas`.

The mock console keeps its data in memory, so write flows change balances and card status until it restarts.
`curl -X POST localhost:4310/reset` restores the seed data; tests and the evidence script do this automatically.

## Fault reference (mock app)

| `--fault`           | Where it fires                | Engine classification              |
|---------------------|-------------------------------|------------------------------------|
| (member 99999)      | lookup                        | business outcome `MEMBER_NOT_FOUND` |
| (deposit < minimum) | sub-account form              | business outcome `VALIDATION_REJECTED` |
| `permission_denied` | card block (`block_card` capability) | business outcome `PERMISSION_DENIED` |
| `interstitial`      | before member summary         | recoverable: acknowledge, re-verify |
| `slow`              | member summary (4 s)          | recoverable: wait                   |
| `session_expired`   | member summary                | recoverable: re-run `auth` steps, restart |
| `confirm_dialog`    | sub-account form submit       | escalate `UNEXPECTED_DIALOG`        |
| `app_error`         | sub-account commit (HTTP 500) | hard failure `APP_ERROR`            |
| `slow_commit`       | sub-account commit (20 s)     | escalate `IRREVERSIBLE_OUTCOME_UNKNOWN`, never re-sent |

## Evidence

`evidence/<runId>/` contains `run.jsonl` (structured, redacted log of what happened and why), `step-NN.png`
screenshots, `result.json`, `failure.png` + `trace.zip` on failure (open with `npx playwright show-trace`), and
`intervention-N.json` for handoffs. Discovery runs also contain `transcript.json` (model conversation; screenshots
omitted and referenced by file path) and `capability.json`.

Logs and transcripts are redacted; screenshots are not. They show whatever the screen showed, which in this
repository is synthetic data only. In production they would go to an access-controlled store with retention,
never into a repository.
