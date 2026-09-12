/**
 * Discovery: the LLM-driven observe -> decide -> act loop.
 *
 * A manual tool loop (not the SDK tool runner) because every proposed action
 * passes through the policy guard and the recorder between model turns, and
 * an irreversible action must be recorded-but-not-executed.
 */
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Capability } from '../schema/capability.js';
import type { Policy } from '../schema/policy.js';
import type { Observation, Surface } from '../surface/types.js';
import { PolicyGuard } from '../policy/guard.js';
import { Redactor } from '../policy/redact.js';
import { RunEvidence } from '../evidence/logger.js';
import { Handoff, type OperatorChannel } from '../handoff/control.js';
import { Recorder } from './recorder.js';
import { SYSTEM_PROMPT, describeObservation, taskPrompt, toolDefinitions } from './prompts.js';

export interface DiscoveryOptions {
  goal: string;
  entryUrl: string;
  params: Record<string, string>;
  sensitiveParams?: string[];
  secretNames: string[];
  policy: Policy;
  surface: Surface;
  evidence: RunEvidence;
  redactor: Redactor;
  operator?: OperatorChannel;
  model?: string;
  maxSteps?: number;
  tenantId?: string;
  vendor?: string;
  profile?: string;
  client?: Anthropic;
}

export type DiscoveryResult =
  | { status: 'success'; capability: Capability; steps: number; summary: string; transcriptPath: string }
  | { status: 'failed'; reason: string; steps: number; transcriptPath: string };

type ActInput = { action: 'click' | 'type' | 'select' | 'press' | 'navigate'; mark?: number; text?: string; param?: string; secret?: string; key?: string; url?: string; reason: string; tags?: string[] };
type ExtractInput = { output: string; value: string; type: 'string' | 'number' | 'currency' | 'boolean'; rowAnchor?: string; columnHeader?: string; label?: string; description?: string; sensitive?: boolean };
type FinishInput = { summary: string; capabilityId: string; name: string; description: string; whenToUse: string; notFor?: string; params?: { name: string; description: string }[] };

export async function discover(o: DiscoveryOptions): Promise<DiscoveryResult> {
  const model = o.model ?? process.env.DISCOVERY_MODEL ?? 'claude-opus-5';
  const client = o.client ?? new Anthropic();
  const guard = new PolicyGuard(o.policy);
  const ev = o.evidence;
  const handoff = new Handoff(o.surface, o.operator, (e, d) => ev.log(e, d));
  const recorder = new Recorder({ entryUrl: o.entryUrl, params: o.params, sensitiveParams: new Set(o.sensitiveParams ?? []), secretNames: o.secretNames });
  for (const p of o.sensitiveParams ?? []) if (o.params[p]) o.redactor.addSensitiveValue(o.params[p]);
  const maxSteps = o.maxSteps ?? o.policy.discovery.maxSteps;
  const deadline = Date.now() + o.policy.discovery.maxDurationMs;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: taskPrompt({ goal: o.goal, entryUrl: o.entryUrl, params: o.params, secretNames: o.secretNames }) }];
  const transcriptPath = join(ev.dir, 'transcript.json');
  const saveTranscript = () => writeFileSync(transcriptPath, JSON.stringify(o.redactor.value(stripImages(messages)), null, 2));

  ev.log('discovery.start', { goal: o.goal, entryUrl: o.entryUrl, model, params: Object.fromEntries(Object.entries(o.params).map(([k, v]) => [k, (o.sensitiveParams ?? []).includes(k) ? Redactor.mask(v) : v])) });

  let last: Observation | undefined;
  let steps = 0;
  let versionObserved: string | undefined;
  const observe = async (): Promise<Observation> => {
    const obs = await o.surface.observe({ marks: true });
    const m = obs.text.match(/CoreServ \d+\.\d+\.\d+/);
    if (m) versionObserved = m[0];
    return obs;
  };

  const fail = (reason: string): DiscoveryResult => {
    ev.error('discovery.end', { status: 'failed', reason, steps });
    saveTranscript();
    return { status: 'failed', reason, steps, transcriptPath };
  };

  for (let turn = 0; turn < maxSteps + 5; turn++) {
    if (Date.now() > deadline) return fail('discovery time budget exhausted');
    if (steps >= maxSteps) return fail(`max steps (${maxSteps}) reached without finishing`);
    pruneImages(messages, 3);

    const response = await client.beta.messages.create({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      tools: toolDefinitions(),
      messages,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    ev.log('llm.turn', { turn, stop: response.stop_reason, model: response.model, in: response.usage.input_tokens, out: response.usage.output_tokens, cacheRead: response.usage.cache_read_input_tokens });
    if (response.stop_reason === 'refusal') return fail(`model refused: ${JSON.stringify(response.stop_details ?? null)}`);
    messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] });
    const thoughts = response.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text);
    if (thoughts.length) ev.log('llm.text', { text: thoughts.join('\n').slice(0, 500) });

    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!uses.length) {
      if (response.stop_reason === 'end_turn') {
        messages.push({ role: 'user', content: 'Continue: use a tool (act, extract, finish or escalate).' });
        continue;
      }
      return fail(`unexpected stop_reason ${response.stop_reason}`);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let finished: DiscoveryResult | undefined;
    for (const use of uses) {
      const input = use.input as Record<string, unknown>;
      // A sensitive extracted value must be masked from the first line it could appear in, including this one.
      if (use.name === 'extract' && input.sensitive && typeof input.value === 'string') o.redactor.addSensitiveValue(input.value);
      ev.log('tool.call', { tool: use.name, input: use.name === 'act' ? { ...input, secretValue: undefined } : input });

      if (use.name === 'finish') {
        const f = input as FinishInput;
        if (!last) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Nothing has been observed yet. Navigate to the entry point first.', is_error: true });
          continue;
        }
        const capability = recorder.build({
          capabilityId: f.capabilityId,
          name: f.name,
          description: f.description,
          whenToUse: f.whenToUse,
          notFor: f.notFor,
          paramDescriptions: Object.fromEntries((f.params ?? []).map((p) => [p.name, p.description])),
          lastObservation: last,
          vendor: o.vendor ?? 'CoreServ',
          profile: o.profile ?? 'coreserv',
          tenantId: o.tenantId,
          versionObserved,
          model,
          runId: ev.runId,
          evidenceRef: ev.dir,
        });
        ev.log('discovery.end', { status: 'success', steps, capabilityId: capability.id, summary: f.summary, checkpointGaps: recorder.checkpointGaps });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Recorded.' });
        finished = { status: 'success', capability, steps, summary: f.summary, transcriptPath };
        continue;
      }

      if (use.name === 'escalate') {
        const reason = String(input.reason ?? 'stuck');
        const shot = ev.screenshot(await o.surface.screenshot(), `intervention-discovery`);
        const peek = await o.surface.peek();
        const rec = await handoff.escalate(
          {
            id: handoff.newRequestId(ev.runId),
            runId: ev.runId,
            capabilityId: '(discovery)',
            goal: o.goal,
            stepId: `discovery-step-${steps}`,
            stepDescription: 'agent is stuck during discovery',
            code: 'DISCOVERY_STUCK',
            reason,
            url: peek.url,
            screenshotPath: shot,
            options: ['retry', 'abort'],
            createdAt: new Date().toISOString(),
          },
          10 * 60_000,
        );
        if (rec.resolution !== 'retry') return fail(`escalated: ${reason} (operator: ${rec.resolution})`);
        last = await observe();
        results.push({ type: 'tool_result', tool_use_id: use.id, content: observationContent(last, ev, `A human operator intervened (${rec.humanActions.length} manual actions recorded, notes: ${rec.notes ?? 'none'}). Control is back with you.`) });
        continue;
      }

      if (use.name === 'extract') {
        const x = input as ExtractInput;
        if (!last) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Observe the page first.', is_error: true });
          continue;
        }
        const source = x.rowAnchor && x.columnHeader
          ? { strategies: [{ kind: 'table-cell' as const, rowAnchor: x.rowAnchor, columnHeader: x.columnHeader }], frame: primaryFrameName(last), rationale: 'Row anchored by its label text, column by header text.' }
          : x.label
            ? { strategies: [{ kind: 'labeled-value' as const, label: x.label }], frame: primaryFrameName(last), rationale: 'Value cell adjacent to its label cell.' }
            : undefined;
        if (!source) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Provide rowAnchor+columnHeader (table) or label (key/value pair).', is_error: true });
          continue;
        }
        const r = await o.surface.resolve(source);
        const live = r ? (await r.text()).replace(/\s+/g, ' ').trim() : undefined;
        if (!r || live !== x.value.replace(/\s+/g, ' ').trim()) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: `Locator did not resolve to that value (live=${JSON.stringify(live ?? null)}). Check the row anchor / column header / label text exactly as displayed.`, is_error: true });
          ev.warn('extract.mismatch', { output: x.output, live, claimed: x.value });
          continue;
        }
        const parse = x.type === 'currency' ? 'currency' : x.type === 'number' ? 'number' : 'text';
        if (x.sensitive) o.redactor.addSensitiveValue(x.value);
        recorder.recordExtract({ output: x.output, source, parse, type: x.type, description: x.description, sensitive: x.sensitive });
        steps++;
        results.push({ type: 'tool_result', tool_use_id: use.id, content: `Recorded output ${x.output}${x.sensitive ? ' (sensitive; masked in evidence)' : ` = ${x.value}`}.` });
        continue;
      }

      if (use.name === 'act') {
        const a = input as ActInput;
        const before = last;
        // Build the surface action.
        let el = undefined as Observation['elements'][number] | undefined;
        if (a.action !== 'navigate') {
          el = before?.elements.find((e) => e.mark === a.mark);
          if (!el) {
            results.push({ type: 'tool_result', tool_use_id: use.id, content: `No control with mark ${a.mark} in the last observation.`, is_error: true });
            continue;
          }
        }
        let value = a.text ?? '';
        if (a.param) {
          if (!(a.param in o.params)) {
            results.push({ type: 'tool_result', tool_use_id: use.id, content: `Unknown param ${a.param}.`, is_error: true });
            continue;
          }
          value = o.params[a.param];
        }
        if (a.secret) {
          const v = process.env[a.secret];
          if (!o.secretNames.includes(a.secret) || v === undefined) {
            results.push({ type: 'tool_result', tool_use_id: use.id, content: `Secret ${a.secret} is not available.`, is_error: true });
            continue;
          }
          value = v;
          o.redactor.addSecret(v);
        }
        const action =
          a.action === 'navigate'
            ? { type: 'navigate' as const, url: a.url ?? o.entryUrl }
            : a.action === 'click'
              ? { type: 'click' as const, target: { mark: a.mark! } }
              : a.action === 'type'
                ? { type: 'type' as const, target: { mark: a.mark! }, text: value, clear: true, secret: !!a.secret }
                : a.action === 'select'
                  ? { type: 'select' as const, target: { mark: a.mark! }, value }
                  : { type: 'press' as const, key: a.key ?? 'Enter', target: { mark: a.mark! } };

        const verdict = guard.check(action, { currentUrl: before?.url ?? o.entryUrl, controlName: el?.name, mode: 'discovery' });
        if (!verdict.allowed) {
          ev.warn('policy.denied', { code: verdict.code, reason: verdict.reason, control: el?.name });
          if (verdict.code === 'IRREVERSIBLE_BLOCKED' && el && before) {
            recorder.recordClick(el, before, before, a.reason, 'irreversible', false);
            steps++;
            results.push({ type: 'tool_result', tool_use_id: use.id, content: `Policy: "${el.name}" is an irreversible action and was NOT executed during discovery. It has been recorded as an approval-gated step for replay. If the goal is reached at this screen, call finish.` });
          } else {
            results.push({ type: 'tool_result', tool_use_id: use.id, content: `Policy blocked this action: ${verdict.reason}`, is_error: true });
          }
          continue;
        }

        try {
          await o.surface.act(action);
        } catch (e) {
          const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
          ev.warn('act.error', { error: msg });
          last = await observe();
          results.push({ type: 'tool_result', tool_use_id: use.id, content: observationContent(last, ev, `Action failed: ${msg}`), is_error: true });
          continue;
        }
        last = await observe();
        steps++;
        const after = last;
        const tags = Array.isArray(a.tags) ? a.tags.filter((t) => t === 'auth') : [];
        if (a.action === 'navigate') recorder.recordNavigate(action.type === 'navigate' ? action.url : o.entryUrl, before, after, a.reason, tags);
        else if (a.action === 'click' && el && before) recorder.recordClick(el, before, after, a.reason, verdict.risk, true, tags);
        else if (a.action === 'type' && el) recorder.recordType(el, a.secret || a.param ? undefined : a.text, a.param, a.secret, a.reason, tags);
        else if (a.action === 'select' && el) recorder.recordSelect(el, a.param ? undefined : a.text, a.param, a.reason, tags);
        else if (a.action === 'press' && before) recorder.recordPress(a.key ?? 'Enter', el, before, after, a.reason, tags);
        if (recorder.checkpointGaps.at(-1) && recorder.steps.at(-1)?.id === recorder.checkpointGaps.at(-1)) ev.warn('recorder.no_checkpoint', { stepId: recorder.steps.at(-1)?.id, note: 'no title/URL change after this action; reviewer must add an expect checkpoint' });
        ev.log('act', { step: steps, action: a.action, control: el?.name, mark: a.mark, risk: verdict.risk, reason: a.reason, title: after.title, url: after.url });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: observationContent(after, ev) });
        continue;
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content: `Unknown tool ${use.name}`, is_error: true });
    }
    messages.push({ role: 'user', content: results });
    saveTranscript();
    if (finished) return finished;
  }
  return fail('loop ended without finish');
}

function primaryFrameName(obs: Observation): string | undefined {
  // The frame whose URL matches the primary URL.
  return obs.frames.find((f) => f.url === obs.url)?.name;
}

function observationContent(obs: Observation, ev: RunEvidence, note?: string): Anthropic.ToolResultBlockParam['content'] {
  const path = ev.screenshot(obs.screenshotPng);
  return [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: obs.screenshotPng.toString('base64') } },
    { type: 'text', text: describeObservation(obs, note) + (path ? `\n[screenshot saved: ${path}]` : '') },
  ];
}

/** Keep only the most recent N screenshots in the conversation to bound context growth. */
function pruneImages(messages: Anthropic.MessageParam[], keep: number) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      for (let j = 0; j < block.content.length; j++) {
        const c = block.content[j];
        if (c.type === 'image') {
          seen++;
          if (seen > keep) block.content[j] = { type: 'text', text: '[earlier screenshot omitted]' };
        }
      }
    }
  }
}

/** Transcript for evidence: images replaced by markers (screenshots are saved separately). */
function stripImages(messages: Anthropic.MessageParam[]) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((b) => {
        if (b.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: b.content.map((c) => (c.type === 'image' ? { type: 'text', text: '[screenshot]' } : c)) };
        if (b.type === 'thinking') return { type: 'text', text: '[thinking]' };
        return b;
      }),
    };
  });
}
