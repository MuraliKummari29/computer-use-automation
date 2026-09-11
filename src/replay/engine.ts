/**
 * Deterministic replay engine.
 *
 * Given a Capability and typed params, executes the recorded steps against a
 * Surface with no model in the loop. Every step: detect known runtime
 * conditions -> resolve the target via the locator bundle -> policy check ->
 * act -> verify the checkpoint. Conditions are classified with the
 * capability's error taxonomy (business outcome / recoverable / hard failure
 * / escalate) and the run returns a structured ReplayResult.
 */
import { join } from 'node:path';
import type { Capability, Checkpoint, Classification, Condition, Detector, Step, TenantOverride, ValueRef } from '../schema/capability.js';
import { FailureCodes, type InterventionRecord, type ReplayResult, type StepReport } from '../schema/result.js';
import type { Policy } from '../schema/policy.js';
import type { Surface, DialogEvent } from '../surface/types.js';
import { PolicyGuard } from '../policy/guard.js';
import { Redactor } from '../policy/redact.js';
import { RunEvidence } from '../evidence/logger.js';
import { Handoff, type InterventionRequest, type OperatorChannel } from '../handoff/control.js';
import { APP_PROFILES, type AppProfile } from '../apps/coreserv.js';

export interface ReplayOptions {
  capability: Capability;
  params: Record<string, string | number | boolean>;
  tenantId?: string;
  /** Caller's explicit approval for irreversible steps on this invocation. */
  approveIrreversible?: boolean;
  policy: Policy;
  surface: Surface;
  evidence: RunEvidence;
  redactor: Redactor;
  operator?: OperatorChannel;
  secrets?: (name: string) => string | undefined;
  interventionTimeoutMs?: number;
  /** Override the entry URL (e.g. a different port for a second tenant). */
  entryUrl?: string;
  profile?: AppProfile;
}

type Peek = { url: string; title: string; text: string; dialogs: DialogEvent[]; lastStatus?: number };

class OutcomeSignal extends Error {
  constructor(readonly outcome: ReplayResult) {
    super('outcome');
  }
}
class RestartSignal extends Error {
  constructor(readonly reason: string) {
    super('restart');
  }
}

export class ReplayEngine {
  private guard: PolicyGuard;
  private handoff: Handoff;
  private outputs: Record<string, string | number | boolean> = {};
  private reports: StepReport[] = [];
  private interventions: InterventionRecord[] = [];
  private approvedSteps = new Set<string>();
  private recoveryCounts = new Map<string, number>();
  private dialogRules: { pattern: string; response: 'accept' | 'dismiss' }[] = [];
  private escalationsPerStep = new Map<string, number>();
  private restarts = 0;
  private startedAt = new Date();
  private steps: Step[] = [];
  private detectors: Detector[] = [];
  private profile: AppProfile;
  private entryUrl: string;

  constructor(private o: ReplayOptions) {
    this.guard = new PolicyGuard(o.policy);
    this.handoff = new Handoff(o.surface, o.operator, (e, d) => o.evidence.log(e, d));
    this.profile = o.profile ?? APP_PROFILES[o.capability.app.profile];
    if (!this.profile) throw new Error(`unknown app profile ${o.capability.app.profile}`);
    const override = o.tenantId ? o.capability.overrides.find((t) => t.tenantId === o.tenantId) : undefined;
    this.steps = applyOverride(o.capability.steps, override);
    this.detectors = [...(override?.extraDetectors ?? []), ...o.capability.detectors, ...this.profile.detectors];
    this.entryUrl = o.entryUrl ?? override?.entryUrl ?? o.capability.app.entryUrl;
  }

  // ---------------- public ----------------
  async run(): Promise<ReplayResult> {
    const { capability: cap, evidence, params } = this.o;
    this.startedAt = new Date();
    evidence.log('replay.start', { capabilityId: cap.id, version: cap.version, tenantId: this.o.tenantId, params: this.maskedParams(), steps: this.steps.length });

    // Sensitive params are masked in everything that leaves the engine.
    for (const p of cap.params) {
      const v = params[p.name];
      if (p.sensitive && typeof v === 'string') this.o.redactor.addSensitiveValue(v);
    }
    // Known dialogs are answered automatically per profile; anything else is dismissed and detected.
    this.o.surface.setDialogRules(this.profile.dialogRules);

    try {
      this.validateParams();
      await this.executeAll();
      await this.verifySuccess();
      return this.finish({ status: 'success', outputs: this.outputs });
    } catch (e) {
      if (e instanceof OutcomeSignal) return e.outcome;
      const msg = e instanceof Error ? e.message : String(e);
      return this.fail(FailureCodes.SURFACE_ERROR, `unhandled surface error: ${msg}`, {});
    }
  }

  // ---------------- orchestration ----------------
  private async executeAll() {
    while (true) {
      try {
        for (let i = 0; i < this.steps.length; i++) await this.executeStep(this.steps[i], i);
        return;
      } catch (e) {
        if (!(e instanceof RestartSignal)) throw e;
        if (this.restarts++ >= 1) throw new OutcomeSignal(await this.fail(FailureCodes.RECOVERY_EXHAUSTED, `restart requested again after recovery (${e.reason})`, {}));
        this.o.evidence.warn('replay.restart', { reason: e.reason });
      }
    }
  }

  private async executeStep(step: Step, index: number) {
    const ev = this.o.evidence;
    const t0 = Date.now();
    const report: StepReport = { stepId: step.id, action: step.action, status: 'ok', attempts: 0, durationMs: 0, drift: false, recoveries: [] };
    // An irreversible step that already executed before a restart must not run twice.
    if (this.restarts > 0 && step.risk === 'irreversible' && this.reports.some((r) => r.stepId === step.id && r.status === 'ok')) {
      ev.warn('step.skip_after_restart', { stepId: step.id });
      return;
    }
    ev.log('step.start', { index, stepId: step.id, action: step.action, description: step.description, risk: step.risk });

    for (;;) {
      report.attempts++;
      // 1. Detect known runtime conditions before acting. Dialog events are consumed here so that
      //    the post-action detection only sees dialogs raised by this attempt.
      const pre = await this.o.surface.peek({ drainDialogs: true });
      pre.dialogs = []; // anything queued before this attempt was already classified after the action that raised it
      const det = this.detect(pre, step);
      if (det) {
        const cont = await this.handleDetection(det, step, report, pre);
        if (cont === 'retry') continue;
        if (cont === 'skip') break;
      }

      // 2. Perform the step.
      const outcome = await this.perform(step, report);
      if (outcome === 'ok') break;
      if (outcome === 'retry') continue;
      if (outcome === 'skip') {
        report.status = 'skipped';
        break;
      }
    }
    report.durationMs = Date.now() - t0;
    report.screenshot = ev.screenshot(await this.o.surface.screenshot());
    this.reports = this.reports.filter((r) => r.stepId !== step.id).concat(report);
    ev.log('step.done', { stepId: step.id, status: report.status, attempts: report.attempts, resolvedBy: report.resolvedBy, drift: report.drift, durationMs: report.durationMs });
  }

  /** Execute the action of a step once. Returns ok | retry | skip; throws OutcomeSignal/RestartSignal. */
  private async perform(step: Step, report: StepReport): Promise<'ok' | 'retry' | 'skip'> {
    const surface = this.o.surface;
    const ev = this.o.evidence;

    // Resolve target (with wait) when the step has one.
    let resolvedName: string | undefined;
    if ('target' in step && step.target) {
      const r = await this.resolveWithWait(step.target, step.timeoutMs);
      if (!r) {
        const peek = await surface.peek();
        const det = this.detect(peek, step);
        if (det) {
          const cont = await this.handleDetection(det, step, report, peek);
          return cont === 'skip' ? 'skip' : 'retry';
        }
        return this.stuck(step, report, FailureCodes.LOCATOR_NOT_FOUND, `no locator strategy resolved the target for step ${step.id}`, {
          expected: describeLocator(step.target),
          observed: `title="${peek.title}" url=${peek.url}`,
        });
      }
      report.resolvedBy = { index: r.index, kind: r.kind };
      report.drift = r.index > 0;
      if (r.index > 0) ev.warn('locator.drift', { stepId: step.id, resolvedBy: r.kind, index: r.index, note: 'a lower-ranked strategy resolved the target; review the artifact' });
      resolvedName = (await r.text().catch(() => ''))?.slice(0, 60);
    }

    // Extract steps read; they never act.
    if (step.action === 'extract') {
      const r = await this.resolveWithWait(step.source, step.timeoutMs);
      if (!r) return this.stuck(step, report, FailureCodes.EXTRACT_FAILED, `could not locate source for output "${step.output}"`, { expected: describeLocator(step.source) });
      const raw = await r.text();
      const spec = this.o.capability.outputs.find((x) => x.name === step.output);
      const value = parseValue(raw, step.parse, spec?.type);
      if (value === undefined) return this.stuck(step, report, FailureCodes.EXTRACT_FAILED, `could not parse "${raw}" as ${step.parse}`, { observed: raw });
      if (spec?.sensitive && typeof value === 'string') this.o.redactor.addSensitiveValue(value);
      this.outputs[step.output] = value;
      report.resolvedBy = { index: r.index, kind: r.kind };
      report.drift = r.index > 0;
      ev.log('extract', { stepId: step.id, output: step.output, value });
      return 'ok';
    }
    if (step.action === 'assert') {
      const ok = await this.waitForCheckpoint(step.checkpoint, step);
      if (ok) return 'ok';
      const peek = await surface.peek();
      return this.stuck(step, report, FailureCodes.CHECKPOINT_FAILED, `assertion failed at ${step.id}`, { expected: describeCheckpoint(step.checkpoint, this.o.params), observed: summarize(peek) });
    }

    // Build the surface action and pass it through the policy guard.
    const action = this.toSurfaceAction(step);
    const controlName = 'target' in step && step.target ? nameOf(step.target) ?? resolvedName : undefined;
    const verdict = this.guard.check(action, {
      currentUrl: (await surface.peek()).url,
      controlName,
      approveIrreversible: this.o.approveIrreversible || this.approvedSteps.has(step.id),
      mode: 'replay',
    });
    if (!verdict.allowed) {
      ev.warn('policy.denied', { stepId: step.id, code: verdict.code, reason: verdict.reason });
      if (verdict.code === 'IRREVERSIBLE_NEEDS_APPROVAL') {
        if (!this.handoff.available)
          throw new OutcomeSignal(await this.fail(FailureCodes.POLICY_BLOCKED, `${verdict.reason}; no operator channel attached to request approval (invoke with approveIrreversible=true or attach an operator)`, { stepId: step.id }));
        const rec = await this.escalate(step, report, 'IRREVERSIBLE_NEEDS_APPROVAL', verdict.reason, { options: ['approve', 'skip', 'abort'] });
        if (rec.resolution === 'approve') {
          this.approvedSteps.add(step.id);
          return 'retry';
        }
        if (rec.resolution === 'skip') return 'skip';
        throw new OutcomeSignal(await this.fail(rec.resolution === 'timeout' ? FailureCodes.INTERVENTION_TIMEOUT : FailureCodes.INTERVENTION_ABORTED, `irreversible step ${step.id} not approved (${rec.resolution})`, { stepId: step.id }));
      }
      throw new OutcomeSignal(await this.fail(FailureCodes.POLICY_BLOCKED, verdict.reason, { stepId: step.id }));
    }
    if (verdict.flagged) ev.warn('policy.flagged', { stepId: step.id, note: verdict.flagged });

    // Act.
    try {
      await surface.act(action);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
      ev.warn('act.error', { stepId: step.id, error: msg });
      const peek = await surface.peek();
      const det = this.detect(peek, step);
      if (det) {
        const cont = await this.handleDetection(det, step, report, peek);
        return cont === 'skip' ? 'skip' : 'retry';
      }
      return this.stuck(step, report, FailureCodes.SURFACE_ERROR, `action failed: ${msg}`, { observed: summarize(peek) });
    }
    ev.log('act', { stepId: step.id, action: action.type, control: controlName, risk: verdict.risk });

    // Verify the post-condition.
    if (step.expect) {
      const ok = await this.waitForCheckpoint(step.expect, step);
      if (!ok) {
        const peek = await surface.peek();
        const det = this.detect(peek, step);
        if (det) {
          const cont = await this.handleDetection(det, step, report, peek);
          if (cont === 'skip') return 'skip';
          // The action already happened; a recovery (e.g. dismissing an interstitial) may have
          // brought us to the expected state. Re-verify before re-acting.
          if (await this.waitForCheckpoint(step.expect)) return 'ok';
          return 'retry';
        }
        return this.stuck(step, report, FailureCodes.CHECKPOINT_FAILED, `checkpoint not met after step ${step.id}`, {
          expected: describeCheckpoint(step.expect, this.o.params),
          observed: summarize(peek),
        });
      }
    } else {
      // No declared checkpoint: still look for known error states so we never proceed blindly.
      const peek = await surface.peek();
      const det = this.detect(peek, step);
      if (det) {
        const cont = await this.handleDetection(det, step, report, peek);
        if (cont === 'skip') return 'skip';
        // Recovered after the action ran (business outcomes/hard failures throw). Nothing to redo.
        return 'ok';
      }
    }
    return 'ok';
  }

  // ---------------- detection & classification ----------------
  private detect(peek: Peek, step: Step): { detector: Detector; matched: string } | undefined {
    for (const d of this.detectors) {
      if (d.onlySteps && !d.onlySteps.includes(step.id)) continue;
      if (d.excludeTags.some((t) => step.tags.includes(t))) continue;
      for (const sig of d.match.anyOf) {
        let matched: string | undefined;
        if (sig.kind === 'text' && peek.text.includes(sig.contains)) matched = lineContaining(peek.text, sig.contains);
        if (sig.kind === 'title' && peek.title.includes(sig.contains)) matched = peek.title;
        if (sig.kind === 'url' && new RegExp(sig.pattern).test(peek.url)) matched = peek.url;
        if (sig.kind === 'http-status' && peek.lastStatus !== undefined && peek.lastStatus >= sig.min && peek.lastStatus <= sig.max) matched = `HTTP ${peek.lastStatus}`;
        if (sig.kind === 'dialog') {
          const dlg = peek.dialogs.find((x) => !x.matchedRule && (!sig.messagePattern || new RegExp(sig.messagePattern, 'i').test(x.message)));
          if (dlg) matched = `${dlg.type}: "${dlg.message}" (auto-${dlg.response}ed)`;
        }
        if (matched !== undefined) return { detector: d, matched };
      }
    }
    return undefined;
  }

  /** Apply the classification. Returns 'retry' to re-run the step, 'skip' to move on; throws to end the run. */
  private async handleDetection(hit: { detector: Detector; matched: string }, step: Step, report: StepReport, peek: Peek): Promise<'retry' | 'skip'> {
    const { detector, matched } = hit;
    const c: Classification = detector.classify;
    const ev = this.o.evidence;
    const message = ('message' in c ? c.message : '').replace('{matched}', matched);
    ev.log('detect', { stepId: step.id, detectorId: detector.id, type: c.type, code: c.code, matched });

    if (c.type === 'business_outcome') {
      for (const x of c.extract) {
        const r = await this.o.surface.resolve(x.source);
        if (r) this.outputs[x.output] = await r.text();
      }
      report.status = 'failed';
      report.note = `${c.code}: ${message}`;
      throw new OutcomeSignal(await this.finish({ status: 'business_outcome', code: c.code, message, outputs: this.outputs, detectorId: detector.id, stepId: step.id }));
    }
    if (c.type === 'hard_failure') {
      throw new OutcomeSignal(await this.fail(c.code, message, { stepId: step.id, observed: summarize(peek) }));
    }
    if (c.type === 'escalate') {
      const dialog = peek.dialogs.find((d) => !d.matchedRule);
      const rec = await this.escalate(step, report, c.code, message, {
        options: dialog ? ['approve', 'skip', 'abort'] : ['retry', 'skip', 'abort'],
        observed: dialog ? `${dialog.type} dialog: "${dialog.message}" (was ${dialog.response}ed); approve = accept it and re-run the step` : summarize(peek),
      });
      if (rec.resolution === 'approve' && dialog) {
        // The operator reviewed the dialog text and chose to proceed through it: accept that exact dialog on retry.
        this.dialogRules.push({ pattern: escapeRegex(dialog.message), response: 'accept' });
        this.o.surface.setDialogRules([...this.profile.dialogRules, ...this.dialogRules]);
        ev.warn('dialog.rule_added', { stepId: step.id, message: dialog.message, by: rec.operator });
        return 'retry';
      }
      if (rec.resolution === 'retry' || rec.resolution === 'approve') return 'retry';
      if (rec.resolution === 'skip') return 'skip';
      throw new OutcomeSignal(await this.fail(rec.resolution === 'timeout' ? FailureCodes.INTERVENTION_TIMEOUT : FailureCodes.INTERVENTION_ABORTED, `${c.code}: ${message}`, { stepId: step.id }));
    }
    // recoverable
    const key = `${detector.id}`;
    const n = (this.recoveryCounts.get(key) ?? 0) + 1;
    this.recoveryCounts.set(key, n);
    if (n > c.maxAttempts) {
      ev.error('recovery.exhausted', { detectorId: detector.id, attempts: n - 1 });
      const rec = await this.escalate(step, report, FailureCodes.RECOVERY_EXHAUSTED, `${c.code} recurred ${n - 1} time(s); recovery "${c.recovery.action}" did not clear it`, { options: ['retry', 'skip', 'abort'] });
      if (rec.resolution === 'retry') return 'retry';
      if (rec.resolution === 'skip') return 'skip';
      throw new OutcomeSignal(await this.fail(FailureCodes.RECOVERY_EXHAUSTED, `${c.code} not cleared by recovery`, { stepId: step.id, observed: summarize(peek) }));
    }
    report.status = 'recovered';
    report.recoveries.push({ detectorId: detector.id, code: c.code, action: c.recovery.action });
    ev.warn('recover', { stepId: step.id, detectorId: detector.id, code: c.code, action: c.recovery.action, attempt: n });
    const rec = c.recovery;
    if (rec.action === 'wait') await this.o.surface.act({ type: 'wait', ms: rec.ms });
    if (rec.action === 'click') await this.o.surface.act({ type: 'click', target: { locator: rec.target } });
    if (rec.action === 'dialog') {
      /* dialog rules are applied by the surface before the next action */
    }
    if (rec.action === 'rerun-tagged') {
      // Re-establish state (e.g. re-authenticate) then replay from the top; completed irreversible steps are skipped.
      for (const s of this.steps.filter((x) => x.tags.includes(rec.tag))) await this.runRecoveryStep(s);
      throw new RestartSignal(`${c.code}: re-ran steps tagged "${rec.tag}"`);
    }
    return 'retry';
  }

  /** Minimal step execution used inside a recovery (no detection recursion). */
  private async runRecoveryStep(step: Step) {
    if (step.action === 'extract' || step.action === 'assert') return;
    const action = this.toSurfaceAction(step);
    if ('target' in step && step.target) {
      const r = await this.resolveWithWait(step.target, step.timeoutMs);
      if (!r) throw new OutcomeSignal(await this.fail(FailureCodes.RECOVERY_EXHAUSTED, `recovery step ${step.id} could not resolve its target`, { stepId: step.id }));
    }
    await this.o.surface.act(action);
    this.o.evidence.log('recovery.step', { stepId: step.id, action: step.action });
    if (step.expect && !(await this.waitForCheckpoint(step.expect)))
      throw new OutcomeSignal(await this.fail(FailureCodes.RECOVERY_EXHAUSTED, `recovery step ${step.id} checkpoint failed`, { stepId: step.id }));
  }

  // ---------------- stuck -> human ----------------
  private async stuck(step: Step, report: StepReport, code: string, reason: string, detail: { expected?: string; observed?: string }): Promise<'ok' | 'retry' | 'skip'> {
    if (report.attempts < 2 && code !== FailureCodes.EXTRACT_FAILED) {
      this.o.evidence.warn('step.retry', { stepId: step.id, code, reason });
      await this.o.surface.act({ type: 'wait', ms: 500 });
      return 'retry';
    }
    const rec = await this.escalate(step, report, code, reason, { ...detail, options: ['retry', 'skip', 'abort'] });
    if (rec.resolution === 'retry') return 'retry';
    if (rec.resolution === 'skip') return 'skip';
    const finalCode = rec.resolution === 'timeout' ? code : rec.resolution === 'abort' && this.handoff.available ? FailureCodes.INTERVENTION_ABORTED : code;
    throw new OutcomeSignal(await this.fail(finalCode, reason, { stepId: step.id, ...detail }));
  }

  private async escalate(
    step: Step,
    report: StepReport,
    code: string,
    reason: string,
    detail: { expected?: string; observed?: string; options: InterventionRequest['options'] },
  ): Promise<InterventionRecord> {
    const n = (this.escalationsPerStep.get(step.id) ?? 0) + 1;
    this.escalationsPerStep.set(step.id, n);
    if (n > 3) throw new OutcomeSignal(await this.fail(FailureCodes.RECOVERY_EXHAUSTED, `step ${step.id} escalated ${n - 1} times without progress (last: ${code}: ${reason})`, { stepId: step.id }));
    const peek = await this.o.surface.peek();
    const shot = this.o.evidence.screenshot(await this.o.surface.screenshot(), `intervention-${this.interventions.length + 1}`);
    const req: InterventionRequest = {
      id: this.handoff.newRequestId(this.o.evidence.runId),
      runId: this.o.evidence.runId,
      capabilityId: this.o.capability.id,
      goal: this.o.capability.description,
      stepId: step.id,
      stepDescription: step.description,
      code,
      reason,
      url: peek.url,
      screenshotPath: shot,
      expected: detail.expected,
      observed: detail.observed,
      options: detail.options,
      createdAt: new Date().toISOString(),
    };
    report.status = 'escalated';
    const rec = await this.handoff.escalate(req, this.o.interventionTimeoutMs ?? 10 * 60_000);
    this.interventions.push(rec);
    this.o.evidence.json(`intervention-${this.interventions.length}.json`, { request: req, record: rec, control: this.handoff.token.transitions });
    return rec;
  }

  // ---------------- helpers ----------------
  private validateParams() {
    for (const p of this.o.capability.params) {
      const v = this.o.params[p.name];
      if (v === undefined || v === '') {
        if (p.required) throw new OutcomeSignal(this.failSync(FailureCodes.MISSING_PARAM, `missing required param "${p.name}"`));
        continue;
      }
      if (p.pattern && !new RegExp(p.pattern).test(String(v))) throw new OutcomeSignal(this.failSync(FailureCodes.MISSING_PARAM, `param "${p.name}" does not match ${p.pattern}`));
    }
  }

  private maskedParams() {
    const out: Record<string, unknown> = {};
    for (const p of this.o.capability.params) {
      const v = this.o.params[p.name];
      out[p.name] = p.sensitive && typeof v === 'string' ? Redactor.mask(v) : v;
    }
    return out;
  }

  private resolveValue(ref: ValueRef): string {
    if (ref.kind === 'literal') return ref.value;
    if (ref.kind === 'param') return String(this.o.params[ref.name] ?? '');
    const v = this.o.secrets?.(ref.name) ?? process.env[ref.name];
    if (v === undefined) throw new OutcomeSignal(this.failSync(FailureCodes.MISSING_PARAM, `secret "${ref.name}" is not available in the environment`));
    this.o.redactor.addSecret(v);
    return v;
  }

  private toSurfaceAction(step: Step) {
    switch (step.action) {
      case 'navigate':
        return { type: 'navigate' as const, url: step.url === '{entryUrl}' ? this.entryUrl : this.substitute(step.url) };
      case 'click':
        return { type: 'click' as const, target: { locator: step.target } };
      case 'type':
        return { type: 'type' as const, target: { locator: step.target }, text: this.resolveValue(step.value), clear: step.clear, secret: step.value.kind === 'secret' };
      case 'select':
        return { type: 'select' as const, target: { locator: step.target }, value: this.resolveValue(step.value) };
      case 'press':
        return { type: 'press' as const, key: step.key, target: step.target ? { locator: step.target } : undefined };
      default:
        throw new Error(`no surface action for ${step.action}`);
    }
  }

  private substitute(s: string) {
    return s.replace(/\{(\w+)\}/g, (_, k) => (k === 'entryUrl' ? this.entryUrl : String(this.o.params[k] ?? `{${k}}`)));
  }

  private async resolveWithWait(locator: Parameters<Surface['resolve']>[0], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.o.surface.resolve(locator);
      if (r) return r;
      if (Date.now() > deadline) return null;
      await this.o.surface.act({ type: 'wait', ms: 300 });
    }
  }

  /**
   * Poll until every condition holds or the timeout elapses. When a step is given, a matching
   * detector ends the wait early: a "member not found" page is classified immediately instead of
   * after the checkpoint timeout.
   */
  private async waitForCheckpoint(cp: Checkpoint, step?: Step): Promise<boolean> {
    const deadline = Date.now() + cp.timeoutMs;
    for (;;) {
      const peek = await this.o.surface.peek();
      let ok = true;
      for (const c of cp.allOf) if (!(await this.condition(c, peek))) ok = false;
      if (ok) return true;
      if (step && this.detect(peek, step)) return false;
      if (Date.now() > deadline) return false;
      await this.o.surface.act({ type: 'wait', ms: 250 });
    }
  }

  private async condition(c: Condition, peek: Peek): Promise<boolean> {
    switch (c.kind) {
      case 'url':
        return new RegExp(this.substituteRegex(c.pattern)).test(peek.url);
      case 'title':
        return peek.title.includes(this.substitute(c.contains));
      case 'text':
        return peek.text.includes(this.substitute(c.contains));
      case 'not-text':
        return !peek.text.includes(this.substitute(c.contains));
      case 'element':
        return !!(await this.o.surface.resolve(c.locator));
    }
  }
  private substituteRegex(p: string) {
    return p.replace(/\{(\w+)\}/g, (_, k) => escapeRegex(String(this.o.params[k] ?? '')));
  }

  private async verifySuccess() {
    const cap = this.o.capability;
    if (!(await this.waitForCheckpoint(cap.success))) {
      const peek = await this.o.surface.peek();
      throw new OutcomeSignal(await this.fail(FailureCodes.SUCCESS_CHECK_FAILED, 'final success condition not met', { expected: describeCheckpoint(cap.success, this.o.params), observed: summarize(peek) }));
    }
    const missing = cap.outputs.filter((o) => this.outputs[o.name] === undefined).map((o) => o.name);
    if (missing.length) throw new OutcomeSignal(await this.fail(FailureCodes.EXTRACT_FAILED, `declared outputs not extracted: ${missing.join(', ')}`, {}));
  }

  private base() {
    const finishedAt = new Date();
    return {
      runId: this.o.evidence.runId,
      capabilityId: this.o.capability.id,
      capabilityVersion: this.o.capability.version,
      tenantId: this.o.tenantId,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      steps: this.reports,
      interventions: this.interventions,
      evidenceDir: this.o.evidence.dir,
    };
  }

  private async finish(partial: Omit<Extract<ReplayResult, { status: 'success' }>, keyof ReturnType<ReplayEngine['base']>> | Omit<Extract<ReplayResult, { status: 'business_outcome' }>, keyof ReturnType<ReplayEngine['base']>>): Promise<ReplayResult> {
    const result = { ...this.base(), ...partial } as ReplayResult;
    this.o.evidence.log('replay.end', { status: result.status, code: 'code' in result ? result.code : undefined, outputs: 'outputs' in result ? result.outputs : undefined });
    this.o.evidence.json('result.json', result);
    return result;
  }

  private failSync(code: string, message: string): ReplayResult {
    const result: ReplayResult = { ...this.base(), status: 'failure', code, message, evidence: { log: this.o.evidence.logPath } };
    this.o.evidence.error('replay.end', { status: 'failure', code, message });
    this.o.evidence.json('result.json', result);
    return result;
  }

  private async fail(code: string, message: string, detail: { stepId?: string; expected?: string; observed?: string }): Promise<ReplayResult> {
    const shot = this.o.evidence.screenshot(await this.o.surface.screenshot().catch(() => Buffer.alloc(0)), 'failure');
    const trace = join(this.o.evidence.dir, 'trace.zip');
    await this.o.surface.saveTrace(trace).catch(() => {});
    const result: ReplayResult = {
      ...this.base(),
      status: 'failure',
      code,
      message,
      stepId: detail.stepId,
      expected: detail.expected,
      observed: detail.observed,
      evidence: { screenshot: shot, trace, log: this.o.evidence.logPath },
    };
    this.o.evidence.error('replay.end', { status: 'failure', code, message, stepId: detail.stepId, expected: detail.expected, observed: detail.observed });
    this.o.evidence.json('result.json', result);
    return result;
  }
}

// ---------------- pure helpers ----------------
export function applyOverride(steps: Step[], override?: TenantOverride): Step[] {
  if (!override) return steps;
  let out = steps.filter((s) => !override.removeSteps.includes(s.id)).map((s) => (override.patchSteps[s.id] ? ({ ...s, ...override.patchSteps[s.id] } as Step) : s));
  for (const ins of override.insertSteps) {
    const i = out.findIndex((s) => s.id === ins.after);
    out = i >= 0 ? [...out.slice(0, i + 1), ins.step, ...out.slice(i + 1)] : [...out, ins.step];
  }
  return out;
}

export function parseValue(raw: string, parse: 'text' | 'currency' | 'number', type?: string): string | number | boolean | undefined {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (parse === 'currency') {
    const m = t.replace(/[,$\s]/g, '').match(/-?\(?\d+(\.\d+)?\)?/);
    if (!m) return undefined;
    const neg = m[0].startsWith('(') || m[0].startsWith('-');
    return (neg ? -1 : 1) * Number(m[0].replace(/[()-]/g, ''));
  }
  if (parse === 'number') {
    const n = Number(t.replace(/[,$]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'boolean') return /^(yes|true|active|on)$/i.test(t);
  return t;
}

function lineContaining(text: string, needle: string) {
  return text.split('\n').find((l) => l.includes(needle))?.trim() ?? needle;
}
function summarize(peek: Peek) {
  return `title="${peek.title}" url=${peek.url}${peek.dialogs.length ? ` dialogs=${peek.dialogs.map((d) => d.message).join('|')}` : ''}`;
}
function describeLocator(l: Parameters<Surface['resolve']>[0]) {
  return l.strategies.map((s) => JSON.stringify(s)).join(' | ');
}
function describeCheckpoint(cp: Checkpoint, params: Record<string, unknown>) {
  return cp.allOf.map((c) => JSON.stringify(c).replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`))).join(' AND ');
}
function nameOf(l: Parameters<Surface['resolve']>[0]): string | undefined {
  for (const s of l.strategies) {
    if (s.kind === 'role') return s.name;
    if (s.kind === 'text') return s.text;
    if (s.kind === 'anchor') return s.anchorText;
  }
  return undefined;
}
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
