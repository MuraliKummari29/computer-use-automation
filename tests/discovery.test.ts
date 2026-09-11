/**
 * Offline test of the discovery loop: a fake model client that "reads" the
 * observation text and issues the tool calls a real model would. This proves
 * the loop -> recorder -> artifact -> replay pipeline end to end without an
 * API key. The real LLM run lives in /evidence/.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ensureMockApp } from '../mock-app/server.js';
import { discover } from '../src/agent/discover.js';
import { PlaywrightSurface } from '../src/surface/playwright.js';
import { Redactor } from '../src/policy/redact.js';
import { RunEvidence, newRunId } from '../src/evidence/logger.js';
import { loadPolicy, runReplay } from '../src/replay/run.js';
import { parseCapability } from '../src/schema/capability.js';

process.env.CORESERV_USER = 'operator';
process.env.CORESERV_PASSWORD = 'demo123';

let app: { close: () => Promise<void> };
beforeAll(async () => {
  app = await ensureMockApp({ port: 4310, tenant: 'harbor' });
});
afterAll(async () => app.close());

/** Scripted "model": decides from the last tool_result text, like a model would from the screenshot + control list. */
function fakeClient() {
  let turn = 0;
  const markOf = (text: string, role: string, name: string) => {
    const m = text.match(new RegExp(`^(\\d+): ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm'));
    return m ? Number(m[1]) : undefined;
  };
  const lastText = (messages: Anthropic.MessageParam[]) => {
    const last = messages[messages.length - 1];
    if (typeof last.content === 'string') return last.content;
    return last.content
      .map((b) => {
        if (b.type !== 'tool_result') return '';
        if (typeof b.content === 'string') return b.content;
        return (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      })
      .join('\n');
  };
  const create = async (req: { messages: Anthropic.MessageParam[] }) => {
    const text = lastText(req.messages);
    turn++;
    let input: Record<string, unknown>;
    let name = 'act';
    if (turn === 1) input = { action: 'navigate', url: 'http://localhost:4310/', reason: 'open the console' };
    else if (text.includes('title="Operator Sign In"') && !text.includes('value="operator"'))
      input = { action: 'type', mark: markOf(text, 'textbox', 'Operator ID'), secret: 'CORESERV_USER', reason: 'enter operator id' };
    else if (text.includes('title="Operator Sign In"') && !text.includes('value="••••"'))
      input = { action: 'type', mark: markOf(text, 'textbox', 'Password'), secret: 'CORESERV_PASSWORD', reason: 'enter password' };
    else if (text.includes('title="Operator Sign In"')) input = { action: 'click', mark: markOf(text, 'button', 'Sign In'), reason: 'sign in' };
    else if (text.includes('title="Member Lookup"') && !text.includes('value="10001"'))
      input = { action: 'type', mark: markOf(text, 'textbox', 'Member Number'), param: 'memberNumber', reason: 'enter the member number' };
    else if (text.includes('title="Member Lookup"')) input = { action: 'click', mark: markOf(text, 'button', 'Find'), reason: 'run the lookup' };
    else if (text.includes('title="Member Summary') && !text.includes('Recorded output savingsBalance') && turn < 9) {
      name = 'extract';
      input = { output: 'savingsBalance', value: '$2,540.12', type: 'currency', rowAnchor: 'Primary Savings', columnHeader: 'Balance', description: 'Primary savings balance' };
    } else if (text.includes('Recorded output savingsBalance')) {
      name = 'extract';
      input = { output: 'memberName', value: 'Alice Harborview', type: 'string', label: 'Name', description: 'Member name', sensitive: true };
    } else {
      name = 'finish';
      input = {
        summary: 'Read the savings balance',
        capabilityId: 'coreserv.member.read_savings',
        name: 'Read savings balance',
        description: 'Look up a member and read the primary savings balance.',
        whenToUse: 'Balance inquiry when no API exists.',
        params: [{ name: 'memberNumber', description: 'Member number' }],
      };
    }
    return {
      id: `msg_${turn}`,
      type: 'message',
      role: 'assistant',
      model: 'fake',
      stop_reason: 'tool_use',
      stop_details: null,
      content: [{ type: 'tool_use', id: `tu_${turn}`, name, input }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    };
  };
  return { beta: { messages: { create } } } as unknown as Anthropic;
}

describe('discovery loop (scripted model) -> artifact -> replay', () => {
  it('records a replayable capability from a driven run', async () => {
    const policy = loadPolicy('policies/coreserv.json');
    const redactor = new Redactor(policy);
    const evidence = new RunEvidence(newRunId('discovery-test'), redactor, 'tests/.evidence', { echo: false });
    const surface = await PlaywrightSurface.launch({ headless: true });
    let result;
    try {
      result = await discover({
        goal: 'Look up member and read the primary savings balance',
        entryUrl: 'http://localhost:4310/',
        params: { memberNumber: '10001' },
        sensitiveParams: ['memberNumber'],
        secretNames: ['CORESERV_USER', 'CORESERV_PASSWORD'],
        policy,
        surface,
        evidence,
        redactor,
        client: fakeClient(),
        model: 'fake',
      });
    } finally {
      await surface.close();
    }
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    const cap = parseCapability(JSON.parse(JSON.stringify(result.capability)));
    // Contract shape
    expect(cap.params.map((p) => p.name)).toEqual(['memberNumber']);
    expect(cap.params[0].sensitive).toBe(true);
    expect(cap.outputs.map((o) => o.name).sort()).toEqual(['memberName', 'savingsBalance']);
    // Secrets are references, never values; auth steps tagged
    const typed = cap.steps.filter((s) => s.action === 'type');
    expect(typed.map((s) => s.action === 'type' && s.value.kind)).toEqual(['secret', 'secret', 'param']);
    expect(JSON.stringify(cap)).not.toContain('demo123');
    // The sensitive output value never reaches the discovery evidence.
    const { readFileSync: rf } = await import('node:fs');
    expect(rf(evidence.logPath, 'utf8')).not.toContain('Harborview');
    expect(rf(result.transcriptPath, 'utf8')).not.toContain('Harborview');
    expect(cap.steps.slice(0, 4).every((s) => s.tags.includes('auth'))).toBe(true);
    expect(cap.steps[4].tags).not.toContain('auth');
    // Param canonicalised in the derived checkpoint
    const find = cap.steps.find((s) => s.description === 'run the lookup')!;
    expect(JSON.stringify(find.expect)).toContain('{memberNumber}');
    // Locator bundles are semantic first
    const mn = cap.steps.find((s) => s.description === 'enter the member number')!;
    expect(mn.action === 'type' && mn.target.strategies[0].kind).toBe('anchor');
    // Replays deterministically with a different member
    const r = await runReplay({ capability: cap, params: { memberNumber: '10003' }, evidenceRoot: 'tests/.evidence', echo: false });
    expect(r.status).toBe('success');
    if (r.status === 'success') expect(r.outputs).toEqual({ memberName: 'Chen Delacroix', savingsBalance: 75000 });
  });
});

describe('discovery loop: escalation to a human', () => {
  it('pauses on the escalate tool, records the handoff, and resumes with a fresh observation', async () => {
    const { ScriptedOperator } = await import('../src/handoff/operators.js');
    const policy = loadPolicy('policies/coreserv.json');
    const redactor = new Redactor(policy);
    const evidence = new RunEvidence(newRunId('discovery-test'), redactor, 'tests/.evidence', { echo: false });
    const surface = await PlaywrightSurface.launch({ headless: true });
    let turn = 0;
    const client = {
      beta: {
        messages: {
          create: async (req: { messages: Anthropic.MessageParam[] }) => {
            turn++;
            const last = req.messages[req.messages.length - 1];
            const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
            let block: Record<string, unknown>;
            if (turn === 1) block = { type: 'tool_use', id: 't1', name: 'act', input: { action: 'navigate', url: 'http://localhost:4310/', reason: 'open' } };
            else if (turn === 2) block = { type: 'tool_use', id: 't2', name: 'escalate', input: { reason: 'I have no credentials for this console' } };
            else {
              expect(text).toContain('A human operator intervened');
              block = { type: 'tool_use', id: 't3', name: 'finish', input: { summary: 'done', capabilityId: 'coreserv.test.escalate', name: 'x', description: 'x', whenToUse: 'x' } };
            }
            return { id: 'm', type: 'message', role: 'assistant', model: 'fake', stop_reason: 'tool_use', stop_details: null, content: [block], usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
      },
    } as unknown as Anthropic;
    const operator = new ScriptedOperator(async (req, s) => {
      expect(req.code).toBe('DISCOVERY_STUCK');
      expect(req.screenshotPath).toBeTruthy();
      // the human signs in on the live session, then hands back
      await s!.act({ type: 'type', target: { locator: { strategies: [{ kind: 'anchor', anchorText: 'Operator ID', relation: 'same-row', controlRole: 'textbox' }] } }, text: 'operator' });
      await s!.act({ type: 'type', target: { locator: { strategies: [{ kind: 'anchor', anchorText: 'Password', relation: 'same-row', controlRole: 'textbox' }] } }, text: 'demo123', secret: true });
      await s!.act({ type: 'click', target: { locator: { strategies: [{ kind: 'role', role: 'button', name: 'Sign In', exact: true }] } } });
      return { resolution: 'retry', operator: 'pat', notes: 'signed in for the agent' };
    }, surface);
    let result;
    try {
      result = await discover({
        goal: 'test escalation',
        entryUrl: 'http://localhost:4310/',
        params: {},
        secretNames: [],
        policy,
        surface,
        evidence,
        redactor,
        operator,
        client,
        model: 'fake',
      });
    } finally {
      await surface.close();
    }
    expect(result.status).toBe('success');
    const { readFileSync } = await import('node:fs');
    const log = readFileSync(evidence.logPath, 'utf8');
    expect(log).toContain('"event":"intervention.requested"');
    expect(log).toContain('"event":"intervention.resolved"');
    expect(log).toContain('"kind":"click"');
    expect(log).not.toContain('demo123');
  });
});
