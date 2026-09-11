import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCapability, Capability } from '../src/schema/capability.js';
import { jsonSchemas } from '../src/schema/index.js';
import { PolicyGuard } from '../src/policy/guard.js';
import { Redactor } from '../src/policy/redact.js';
import { loadPolicy } from '../src/replay/run.js';
import { applyOverride, parseValue } from '../src/replay/engine.js';
import { ControlToken } from '../src/handoff/control.js';

const policy = loadPolicy('policies/coreserv.json');

describe('artifact schema', () => {
  it('parses the fixtures and applies defaults', () => {
    const cap = parseCapability(JSON.parse(readFileSync('tests/fixtures/read_balances.json', 'utf8')));
    expect(cap.steps[0].tags).toEqual(['auth']);
    expect(cap.params[0].sensitive).toBe(true);
    const cap2 = parseCapability(JSON.parse(readFileSync('tests/fixtures/open_subaccount.json', 'utf8')));
    expect(cap2.policy.requiresApproval).toBe(true);
  });
  it('rejects a capability with a bad id or missing success checkpoint', () => {
    const cap = JSON.parse(readFileSync('tests/fixtures/read_balances.json', 'utf8'));
    expect(() => parseCapability({ ...cap, id: 'Has Spaces' })).toThrow();
    expect(() => parseCapability({ ...cap, success: undefined })).toThrow();
    expect(() => parseCapability({ ...cap, steps: [{ ...cap.steps[1], value: { kind: 'password', value: 'x' } }] })).toThrow();
  });
  it('exports JSON schemas for reviewers', () => {
    const s = jsonSchemas();
    expect(JSON.stringify(s.capability)).toContain('schemaVersion');
    expect(JSON.stringify(s.replayResult)).toContain('business_outcome');
    expect(Capability.safeParse({}).success).toBe(false);
  });
});

describe('policy guard', () => {
  const guard = new PolicyGuard(policy);
  it('enforces the origin and path allowlist', () => {
    expect(guard.check({ type: 'navigate', url: 'http://localhost:4310/app/search' }, { currentUrl: 'about:blank', mode: 'replay' }).allowed).toBe(true);
    expect(guard.check({ type: 'navigate', url: 'https://evil.example/app/search' }, { currentUrl: 'about:blank', mode: 'replay' })).toMatchObject({ allowed: false, code: 'ORIGIN_NOT_ALLOWED' });
    expect(guard.check({ type: 'navigate', url: 'http://localhost:4310/admin/users' }, { currentUrl: 'about:blank', mode: 'replay' })).toMatchObject({ allowed: false, code: 'PATH_NOT_ALLOWED' });
  });
  it('classifies risk from the control name and gates irreversible actions', () => {
    const click = { type: 'click' as const, target: { mark: 1 } };
    const url = 'http://localhost:4310/app/member/10001/subaccount/confirm';
    expect(guard.classify(click, { currentUrl: url, controlName: 'Find' })).toBe('reversible');
    expect(guard.classify(click, { currentUrl: url, controlName: 'Confirm and Open' })).toBe('irreversible');
    expect(guard.check(click, { currentUrl: url, controlName: 'Confirm and Open', mode: 'discovery' })).toMatchObject({ allowed: false, code: 'IRREVERSIBLE_BLOCKED' });
    expect(guard.check(click, { currentUrl: url, controlName: 'Confirm and Open', mode: 'replay' })).toMatchObject({ allowed: false, code: 'IRREVERSIBLE_NEEDS_APPROVAL' });
    expect(guard.check(click, { currentUrl: url, controlName: 'Confirm and Open', mode: 'replay', approveIrreversible: true })).toMatchObject({ allowed: true, risk: 'irreversible' });
  });
});

describe('redaction', () => {
  it('scrubs secrets, masks sensitive values and applies policy patterns', () => {
    const r = new Redactor(policy);
    r.addSecret('demo123');
    r.addSensitiveValue('10001');
    const out = r.text('typed demo123 for member 10001, ssn 123-45-6789, phone 555-0101');
    expect(out).not.toContain('demo123');
    expect(out).toContain('[secret]');
    expect(out).toContain('***0001');
    expect(out).toContain('***-**-####');
    expect(out).not.toContain('123-45-6789');
    expect(r.value({ a: 'demo123', b: [Buffer.from('x')] })).toEqual({ a: '[secret]', b: ['[binary 1 bytes]'] });
  });
});

describe('replay helpers', () => {
  it('parses currency and numbers', () => {
    expect(parseValue('$2,540.12', 'currency')).toBe(2540.12);
    expect(parseValue('($12.00)', 'currency')).toBe(-12);
    expect(parseValue('abc', 'currency')).toBeUndefined();
    expect(parseValue('1,200', 'number')).toBe(1200);
    expect(parseValue(' Alice  Harborview ', 'text')).toBe('Alice Harborview');
  });
  it('applies tenant overrides without touching the base steps', () => {
    const cap = parseCapability(JSON.parse(readFileSync('tests/fixtures/read_balances.json', 'utf8')));
    const summit = applyOverride(cap.steps, cap.overrides[0]);
    const s = summit.find((x) => x.id === 'member-number')!;
    expect(s.action === 'type' && s.target.strategies[0].kind === 'anchor' && s.target.strategies[0].anchorText).toBe('Account #');
    const base = cap.steps.find((x) => x.id === 'member-number')!;
    expect(base.action === 'type' && base.target.strategies[0].kind === 'anchor' && base.target.strategies[0].anchorText).toBe('Member Number');
  });
});

describe('control token', () => {
  it('only allows the documented transitions', () => {
    const t = new ControlToken();
    expect(t.automationMayAct).toBe(true);
    expect(() => t.transition('human', 'x')).toThrow();
    t.transition('intervention_requested', 'engine');
    t.transition('human', 'operator');
    expect(t.automationMayAct).toBe(false);
    expect(() => t.transition('automation', 'x')).toThrow();
    t.transition('resuming', 'engine');
    t.transition('automation', 'engine');
    expect(t.transitions.map((x) => x.to)).toEqual(['intervention_requested', 'human', 'resuming', 'automation']);
  });
});
