import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { ensureMockApp } from '../mock-app/server.js';
import { runReplay } from '../src/replay/run.js';
import { ScriptedOperator } from '../src/handoff/operators.js';
import { PlaywrightSurface } from '../src/surface/playwright.js';

process.env.CORESERV_USER = 'operator';
process.env.CORESERV_PASSWORD = 'demo123';

const READ = 'tests/fixtures/read_balances.json';
const OPEN = 'tests/fixtures/open_subaccount.json';
const EV = 'tests/.evidence';
let apps: { close: () => Promise<void> }[] = [];

beforeAll(async () => {
  apps = [await ensureMockApp({ port: 4310, tenant: 'harbor' }), await ensureMockApp({ port: 4311, tenant: 'summit' })];
});
afterAll(async () => {
  for (const a of apps) await a.close();
});

const opts = { evidenceRoot: EV, echo: false };

describe('deterministic replay: read balances', () => {
  it('succeeds with typed outputs', async () => {
    const r = await runReplay({ ...opts, capability: READ, params: { memberNumber: '10001' } });
    expect(r.status).toBe('success');
    if (r.status === 'success') expect(r.outputs).toEqual({ memberName: 'Alice Harborview', savingsBalance: 2540.12, checkingBalance: 1203.55 });
    expect(r.steps.every((s) => s.status === 'ok' && !s.drift)).toBe(true);
  });
  it('reports "member not found" as a business outcome, not a failure', async () => {
    const r = await runReplay({ ...opts, capability: READ, params: { memberNumber: '99999' } });
    expect(r.status).toBe('business_outcome');
    if (r.status === 'business_outcome') {
      expect(r.code).toBe('MEMBER_NOT_FOUND');
      expect(r.stepId).toBe('find');
    }
  });
  it('rejects a malformed param before touching the UI', async () => {
    const r = await runReplay({ ...opts, capability: READ, params: { memberNumber: 'abc' } });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') expect(r.code).toBe('MISSING_PARAM');
  });
  it('dismisses a known interstitial and continues (recoverable)', async () => {
    const r = await runReplay({ ...opts, capability: READ, params: { memberNumber: '10001' }, fault: 'interstitial' });
    expect(r.status).toBe('success');
    const find = r.steps.find((s) => s.stepId === 'find')!;
    expect(find.status).toBe('recovered');
    expect(find.recoveries[0].code).toBe('INTERSTITIAL_SYSTEM_NOTICE');
  });
  it('waits through a slow load', async () => {
    const r = await runReplay({ ...opts, capability: READ, params: { memberNumber: '10001' }, fault: 'slow' });
    expect(r.status).toBe('success');
  });
  it('re-authenticates after a session expiry and completes', async () => {
    const r = await runReplay({ ...opts, capability: READ, params: { memberNumber: '10003' }, fault: 'session_expired' });
    expect(r.status).toBe('success');
    if (r.status === 'success') expect(r.outputs.savingsBalance).toBe(75000);
  });
  it('replays on a second tenant (different label + compliance interstitial) via overrides, not re-recording', async () => {
    const r = await runReplay({ ...opts, capability: READ, params: { memberNumber: '10042' }, tenantId: 'summit' });
    expect(r.status).toBe('success');
    if (r.status === 'success') expect(r.outputs.memberName).toBe('Dana Whitfield');
    // The compliance interstitial was handled by the shared app profile.
    expect(r.steps.some((s) => s.recoveries.some((x) => x.code === 'INTERSTITIAL_COMPLIANCE'))).toBe(true);
  });
  it('masks sensitive params in the evidence log', async () => {
    const r = await runReplay({ ...opts, capability: READ, params: { memberNumber: '10002' } });
    const { readFileSync } = await import('node:fs');
    const log = readFileSync(`${r.evidenceDir}/run.jsonl`, 'utf8');
    expect(log).not.toContain('"10002"');
    expect(log).toContain('***0002');
    expect(log).not.toContain('demo123');
  });
});

describe('deterministic replay: open sub-account (irreversible)', () => {
  const params = { memberNumber: '10001', product: 'CLUB', nickname: 'Vacation', initialDeposit: '50' };

  it('surfaces a validation rejection as a business outcome with the app message', async () => {
    const r = await runReplay({ ...opts, capability: OPEN, params: { ...params, initialDeposit: '5' }, approveIrreversible: true });
    expect(r.status).toBe('business_outcome');
    if (r.status === 'business_outcome') {
      expect(r.code).toBe('VALIDATION_REJECTED');
      expect(r.message).toContain('must be at least $25.00');
      expect(r.stepId).toBe('continue');
    }
  });
  it('blocks the irreversible commit without approval and without an operator', async () => {
    const r = await runReplay({ ...opts, capability: OPEN, params });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') {
      expect(r.code).toBe('POLICY_BLOCKED');
      expect(r.stepId).toBe('commit');
    }
  });
  it('escalates the irreversible commit to a human who approves it, then completes', async () => {
    const op = new ScriptedOperator((req) => ({ resolution: req.options.includes('approve') ? 'approve' : 'abort', operator: 'jane', notes: 'verified with member on the phone' }));
    const r = await runReplay({ ...opts, capability: OPEN, params: { ...params, nickname: 'Approved' }, operator: op });
    expect(r.status).toBe('success');
    if (r.status === 'success') {
      expect(r.outputs.confirmationNumber).toMatch(/^CF/);
      expect(r.outputs.newShareId).toMatch(/^S\d\d$/);
    }
    expect(op.requests[0].code).toBe('IRREVERSIBLE_NEEDS_APPROVAL');
    expect(r.interventions[0]).toMatchObject({ resolution: 'approve', operator: 'jane', stepId: 'commit' });
    expect(existsSync(`${r.evidenceDir}/intervention-1.json`)).toBe(true);
  });
  it('reports an application error as a hard failure with debuggable detail and evidence', async () => {
    const r = await runReplay({ ...opts, capability: OPEN, params: { ...params, nickname: 'Err' }, approveIrreversible: true, fault: 'app_error' });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') {
      expect(r.code).toBe('APP_ERROR');
      expect(r.stepId).toBe('commit');
      expect(r.observed).toContain('Application Error');
      expect(existsSync(r.evidence.screenshot!)).toBe(true);
      expect(existsSync(r.evidence.trace!)).toBe(true);
    }
  });
  it('escalates an unexpected native dialog; the human hands control back and the run resumes', async () => {
    const op = new ScriptedOperator((req) => ({ resolution: req.options.includes('approve') ? 'approve' : 'retry', operator: 'sam', notes: 'dialog was a benign fee notice' }));
    const r = await runReplay({ ...opts, capability: OPEN, params: { ...params, nickname: 'Dialog' }, operator: op, fault: 'confirm_dialog' });
    expect(r.status).toBe('success');
    const codes = op.requests.map((q) => q.code);
    expect(codes).toContain('UNEXPECTED_DIALOG');
    expect(r.interventions.length).toBeGreaterThanOrEqual(2);
  });
  it('records what the human did on the live session during a handoff', async () => {
    // Use a shared surface so the scripted "human" can act on the same live session.
    const surface = await PlaywrightSurface.launch({ headless: true });
    try {
      const op = new ScriptedOperator(async (req, s) => {
        if (req.code === 'UNEXPECTED_DIALOG' && s) {
          // The human re-submits the form themselves, then hands back with "skip".
          await s.act({ type: 'click', target: { locator: { strategies: [{ kind: 'role', role: 'button', name: 'Continue', exact: true }] } } });
          return { resolution: 'skip', operator: 'lee', notes: 'clicked Continue manually' };
        }
        return { resolution: 'approve', operator: 'lee' };
      }, surface);
      const r = await runReplay({ ...opts, capability: OPEN, params: { ...params, nickname: 'Human' }, operator: op, fault: 'confirm_dialog', surface });
      expect(r.status).toBe('success');
      const dialogIntervention = r.interventions.find((i) => i.code === 'UNEXPECTED_DIALOG')!;
      expect(dialogIntervention.resolution).toBe('skip');
      expect(dialogIntervention.humanActions.some((a) => a.kind === 'click' && a.detail.includes('Continue'))).toBe(true);
      expect(r.steps.find((s) => s.stepId === 'continue')!.status).toBe('skipped');
    } finally {
      await surface.close();
    }
  });
});

describe('deterministic replay: block card (permission-gated)', () => {
  const BLOCK = 'tests/fixtures/block_card.json';
  it('treats a permission denial as a business outcome, not a failure', async () => {
    const r = await runReplay({ ...opts, capability: BLOCK, params: { memberNumber: '10001' }, approveIrreversible: true, fault: 'permission_denied' });
    expect(r.status).toBe('business_outcome');
    if (r.status === 'business_outcome') {
      expect(r.code).toBe('PERMISSION_DENIED');
      expect(r.stepId).toBe('block');
      expect(r.message).toContain('Not Authorized');
    }
  });
  it('places the block when approved and returns the confirmation line', async () => {
    const r = await runReplay({ ...opts, capability: BLOCK, params: { memberNumber: '10042' }, approveIrreversible: true });
    expect(r.status).toBe('success');
    if (r.status === 'success') expect(String(r.outputs.confirmationMessage)).toContain('Temporary block placed on card ending 0042');
  });
});
