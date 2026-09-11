# Design write-up

## 1. Architecture

One TypeScript process, four layers, one seam. Distribution was not the hard part; the contracts and the failure
handling were.

```
 goal ─► Discovery agent (Claude) ──► Recorder ──► Capability artifact (JSON)
              │ observe/act                                    │
              ▼                                                ▼
        ┌──────────── Surface seam ────────────┐      Replay engine (no LLM)
        │ observe() → screenshot + marked      │ ◄──  detect → resolve → policy → act → verify
        │ act()      elements + text            │             │
        │ resolve()  locator bundle → element   │             ▼
        └──── PlaywrightSurface (web today) ────┘      ReplayResult (success | business_outcome | failure)
                       ▲
        Policy guard ──┴── Handoff (control token + operator channel) ── Evidence (jsonl, png, trace)
```

Key decisions:

- **Perception is screenshot + set-of-marks, not the DOM.** The agent sees numbered boxes over interactive
  controls and a list `mark: role "name" [frame]`, built from every frame of the frameset. Legacy inputs with no
  programmatic label get their adjacent label cell as the name. The model never sees a selector, so its decisions
  are surface-agnostic; the same information comes from an OS accessibility API on a desktop app.
- **Manual tool loop, not the SDK tool runner.** Every proposed action passes through the policy guard and the
  recorder between turns, and an irreversible action must be recorded but not executed.
- **The target is a local, intentionally hostile mock** (server-rendered framesets, table layout, no ids, labels
  not associated with inputs) with two tenant configurations and injectable runtime faults, because the brief's
  hard part is runtime conditions and I need session expiry, interstitials, validation errors, HTTP 500s and
  native dialogs on demand and reproducibly.
- **Replay was built and tested before discovery**, against a hand-authored artifact and every fault, because
  replay is the production path.
- **Claude Opus 5** with adaptive thinking and the server-side refusal fallback. The real run
  (`evidence/discovery-20260911T041205Z-7ff9/`) took 8 model turns and produced
  `capabilities/coreserv.member.read_balances.json`, which replays unchanged on both tenants.

## 2. Artifact schema

`src/schema/capability.ts` (Zod; JSON Schema in `schema/`). It is a callable contract first, a step list second.

- **Identity and lifecycle**: dotted `id`, semver `version`, `status` (`draft → approved → deprecated`). The
  catalog refuses unattended invocation of drafts.
- **Contract**: typed `params` (`required`, `pattern`, `sensitive`), typed `outputs` (incl. `currency`),
  `usage.whenToUse / notFor`. `npm run catalog` renders exactly this as a tool definition for a calling agent.
- **Steps**: `navigate | click | type | select | press | extract | assert`, each with a `risk` class, `tags`
  (e.g. `auth`) and an `expect` checkpoint. Values are `ValueRef`s: `literal`, `param`, or `secret` by name,
  resolved from the environment at replay and never stored.
- **Locator bundles**, ordered most to least robust, none of them a DOM path: `role`+name, `text`, `anchor`
  (control in the same row as, right of, or below a visible label cell: the legacy case), `table-cell` (row anchor
  + column header), `labeled-value`, and `bbox` last (viewport-normalised, role-checked, flagged as drift when
  used). `css` is an explicit, discouraged escape hatch. Each bundle carries a `rationale`.
- **Checkpoints**: `allOf` conditions on title, URL regex, text or element presence, with `{param}` placeholders
  (`Member Summary - {memberNumber}`).
- **Detectors** carry the error taxonomy (section 3). The capability's own are merged with the vendor
  **app profile** (`src/apps/coreserv.ts`), so what a session expiry looks like is written once per product.
- **Overrides** per tenant (section 4), a **policy summary** (`maxRisk`, `requiresApproval`), and **provenance**
  (model, run id, evidence ref, reviewer notes). The model transcript lives in evidence, never in the artifact.

The recorder derives most of this mechanically: bundles from the surface, checkpoints from before/after
observations, param canonicalisation, `auth` tagging. The model contributes the human-facing contract and the
extraction locators, which are verified against the live page before they are accepted.

## 3. Determinism & error handling

Replay never calls a model. Per step: peek and run detectors; resolve the target through the bundle, polling up to
the step timeout; policy check; act; poll the checkpoint, running detectors on every poll so a "no member found"
page is classified in a second rather than after the timeout. Waits are condition-based; the only fixed delays are
the 250 ms polling intervals. The strategy that resolved each target is recorded; anything but the first is a
**drift warning** on the step, not a failure.

| Class | Meaning | Engine behaviour | Examples |
|---|---|---|---|
| `business_outcome` | a legitimate answer the caller must handle | stop; return `code`, the app's own message, partial outputs | `MEMBER_NOT_FOUND`, `VALIDATION_REJECTED` ("must be at least $25.00"), `PERMISSION_DENIED` |
| recoverable | known condition the engine clears itself | run the recovery, retry within `maxAttempts`, step reports `recovered` | interstitial → acknowledge; slow load → wait; session expiry → re-run `auth` steps and restart (completed irreversible steps are skipped) |
| escalate | not safe to decide automatically | hand to a human (section 5) | unknown native dialog |
| `failure` | stop with a debuggable error | `code`, `stepId`, `expected`, `observed`, screenshot, Playwright trace, jsonl log | `APP_ERROR` (title or HTTP 5xx), `LOCATOR_NOT_FOUND`, `CHECKPOINT_FAILED`, `POLICY_BLOCKED`, `INTERVENTION_ABORTED` |

Two subtleties the tests caught: a recovery that fires during checkpoint verification must re-verify, not re-act
(otherwise "acknowledge the notice" is followed by clicking a button that no longer exists); and dialog events must
not be consumed by checkpoint polling before detection sees them. Detectors can be excluded on tagged steps, so
"you are on the sign-in page" is not an error while signing in. UI drift, secondary here, is handled by bundle order
plus the drift flag, and the observed app version is recorded so a replay on a new build can be re-validated.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** `Surface` (`src/surface/types.ts`) is the seam: `observe()` returns a screenshot plus
marked elements with role, name, frame and a locator bundle; `act()` takes abstract actions by mark, locator or
point; `resolve()` turns a bundle into a live element. The artifact and engine use only this vocabulary. Legacy web
is the implemented case. A desktop surface would implement the same interface over macOS AX or Windows UIA:
`role`+name and `text` map directly, `anchor` becomes geometric ("textbox right of the static text 'Member
Number'"), `table-cell` maps to table/row/cell roles, `bbox` is unchanged, `css` is unsupported. Where an app
exposes nothing (Citrix, image-only), only `bbox` remains and the rationale says so, which is the honest signal
that the capability is fragile.

**Multi-tenant reuse** composes three layers at replay time: the **app profile** (per vendor product: detectors,
dialog rules), the **capability** (recorded once), and a small **tenant override** (`patchSteps`, `insertSteps`,
`removeSteps`, `extraDetectors`, `entryUrl`). The repository demonstrates it: the artifact recorded on "Harbor FCU"
replays on "Summit Community Bank", which runs a newer console build, labels the field "Account #", and shows a
compliance interstitial after sign-in. The override is one patched step; the interstitial needed nothing because
the profile already knows it. **Drift detection** is the per-step `resolvedBy` signal aggregated per tenant and app
version: a tenant that starts resolving through fallbacks needs an override or the base needs a new version. Next
would be canary replays per tenant after vendor upgrades and promoting an override into the base when most tenants
need it.

## 5. Escalation & handoff

**Stuck** is any of: a detector classified `escalate`; an irreversible step without approval; a target no bundle
resolves or a checkpoint that fails after one retry; a recovery that exhausts its attempts; the discovery agent
calling its `escalate` tool. Escalations are capped at three per step.

**Control transfer.** A `ControlToken` (`src/handoff/control.ts`) is the single source of truth for who holds the
live session, with only these transitions, each logged with actor and time:
`automation → intervention_requested → human → resuming → automation`. The engine does not act outside
`automation`. The request carries capability, goal, step, why it stopped, expected vs observed, URL, a screenshot,
and the resolutions on offer.

**Taking the live session.** The browser is the same Playwright context the automation is using; run headed, the
human acts in that window. While the token is `human`, a recorder in every frame streams clicks, changes and key
presses (passwords masked) into the intervention record; native dialogs raised during human control are accepted
on their behalf and recorded, since a Playwright-driven session cannot display them. The operator surface at
`localhost:4400` is a bare HTML page (request, screenshot, "Take control", notes, hand-back buttons). It is a
stand-in; the seam is real, and a `ScriptedOperator` implements the same `OperatorChannel` in tests.

**Handing back.** `retry` re-runs the current step, `skip` marks it done because the human did it, `approve`
authorises the irreversible action (or accepts a reviewed dialog) and re-runs, `abort` ends with
`INTERVENTION_ABORTED`. On resume the engine re-runs detection and the checkpoint rather than trusting the human,
and the full record (resolution, operator, notes, human actions, token transitions) is written to
`intervention-N.json` and returned in the result.

## 6. Safety

- **Allowlist** (`policies/coreserv.json`): origins, path regexes, denied paths, permitted action types, enforced
  by `PolicyGuard.check` before every action in discovery and replay.
- **Risk classes.** `read | reversible | irreversible`, from the action and the control's accessible name or URL
  matched against policy patterns. Irreversible actions are never executed during discovery; they are recorded as
  approval-gated steps and the agent stops at the review screen. On replay the invocation must carry
  `approveIrreversible` (an explicit decision by the calling system) or the step escalates; with no operator
  attached it fails closed. `block` and `flag` modes exist for stricter or looser tenants.
- **Data.** Secrets are referenced by name, resolved at run time, and scrubbed from every log line, transcript and
  result. Sensitive params and outputs are masked to their last four characters in evidence. Policy regexes scrub
  SSN, card and phone patterns from free text. Transcripts store screenshots as file references.
- **Limits.** Screenshots contain whatever was on screen (synthetic here; in production an access-controlled
  store with retention). Name-based risk classification depends on the policy author naming the right controls; a
  renamed control would silently downgrade to `reversible`, which is why drift signals and `approved` gating
  matter. The redactor is pattern-based and will miss unstructured PII.

## 7. Cuts

Left out deliberately: a real operator console (the page is a stub over a real seam); a desktop surface (interface
designed, nothing implemented); tenant registry and drift dashboard (overrides are demonstrated in-process on two
mock tenants); confidence scoring (`drift`/`resolvedBy` are recorded per step, not aggregated); bounded LLM
recovery on replay failure; code generation; multi-run stability. The two write-flow capabilities were completed by
hand from what discovery can record, because policy forbids discovery from executing their commit step; that is the
intended review workflow, not a shortcut.

Next, in order: a review CLI that diffs artifact versions and flips `status`; per-tenant canary replays after
vendor upgrades feeding a drift dashboard; bounded assisted recovery for a single failed step under the same policy
guard; a desktop `Surface` over macOS accessibility to prove the seam; a co-browsing operator view (CDP screencast)
instead of a headed window.
