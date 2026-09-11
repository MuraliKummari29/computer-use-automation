/**
 * Recorder: turns the discovery agent's verified actions into Capability steps.
 *
 * It is the bridge between "what the model did" and "what replay will do":
 *  - marks become locator bundles (from the surface, not from the model)
 *  - literal values that equal a param value become param references
 *  - secrets are references by name only
 *  - each navigation-causing action gets a derived checkpoint (title/url)
 *  - concrete param values in URLs/titles are canonicalised to {param}
 */
import type { Capability, Checkpoint, Condition, ParamSpec, OutputSpec, Step, RiskClass, ValueRef } from '../schema/capability.js';
import { SCHEMA_VERSION } from '../schema/capability.js';
import type { Locator } from '../schema/locator.js';
import type { MarkedElement, Observation } from '../surface/types.js';

export interface RecorderContext {
  entryUrl: string;
  params: Record<string, string>;
  sensitiveParams: Set<string>;
  secretNames: string[];
}

export class Recorder {
  readonly steps: Step[] = [];
  readonly outputs: OutputSpec[] = [];
  private seq = 0;

  constructor(private ctx: RecorderContext) {}

  private id(prefix: string) {
    return `${prefix}-${++this.seq}`;
  }

  /** Replace concrete param values with {param} placeholders (longest values first to avoid partial hits). */
  canonicalize(s: string): string {
    let out = s;
    const entries = Object.entries(this.ctx.params).sort((a, b) => b[1].length - a[1].length);
    for (const [k, v] of entries) if (v.length >= 3) out = out.split(v).join(`{${k}}`);
    return out;
  }

  private valueRef(literal: string | undefined, param: string | undefined, secret: string | undefined): ValueRef {
    if (secret) return { kind: 'secret', name: secret };
    if (param) return { kind: 'param', name: param };
    const text = literal ?? '';
    const hit = Object.entries(this.ctx.params).find(([, v]) => v === text && v.length >= 3);
    return hit ? { kind: 'param', name: hit[0] } : { kind: 'literal', value: text };
  }

  /** Derive the post-condition from what the screen looked like after the action. */
  checkpointFrom(before: Observation, after: Observation): Checkpoint | undefined {
    const allOf: Condition[] = [];
    if (after.title && after.title !== before.title) allOf.push({ kind: 'title', contains: this.canonicalize(after.title) });
    if (after.url !== before.url) {
      try {
        const path = new URL(after.url).pathname;
        allOf.push({ kind: 'url', pattern: escapeRegexKeepingParams(this.canonicalize(path)) + '$' });
      } catch {
        /* ignore */
      }
    }
    return allOf.length ? { allOf, timeoutMs: 8000 } : undefined;
  }

  recordNavigate(url: string, before: Observation | undefined, after: Observation, reason: string) {
    const step: Step = {
      id: this.id('open'),
      action: 'navigate',
      url: url === this.ctx.entryUrl ? '{entryUrl}' : this.canonicalize(url),
      description: reason,
      tags: [],
      risk: 'read',
      expect: after.title ? { allOf: [{ kind: 'title', contains: this.canonicalize(after.title) }], timeoutMs: 8000 } : undefined,
      timeoutMs: 8000,
    };
    void before;
    this.steps.push(step);
    return step;
  }

  recordClick(el: MarkedElement, before: Observation, after: Observation, reason: string, risk: RiskClass, executed: boolean) {
    const step: Step = {
      id: this.id('click'),
      action: 'click',
      target: el.locator,
      description: executed ? reason : `${reason} (irreversible: not executed during discovery; requires approval on replay)`,
      tags: [],
      risk,
      expect: executed ? this.checkpointFrom(before, after) : undefined,
      timeoutMs: 8000,
    };
    this.steps.push(step);
    return step;
  }

  recordType(el: MarkedElement, literal: string | undefined, param: string | undefined, secret: string | undefined, reason: string) {
    const step: Step = {
      id: this.id('type'),
      action: 'type',
      target: el.locator,
      value: this.valueRef(literal, param, secret),
      clear: true,
      description: reason,
      tags: [],
      risk: 'reversible',
      timeoutMs: 8000,
    };
    this.steps.push(step);
    return step;
  }

  recordSelect(el: MarkedElement, literal: string | undefined, param: string | undefined, reason: string) {
    const step: Step = {
      id: this.id('select'),
      action: 'select',
      target: el.locator,
      value: this.valueRef(literal, param, undefined),
      description: reason,
      tags: [],
      risk: 'reversible',
      timeoutMs: 8000,
    };
    this.steps.push(step);
    return step;
  }

  recordPress(key: string, el: MarkedElement | undefined, before: Observation, after: Observation, reason: string) {
    const step: Step = {
      id: this.id('press'),
      action: 'press',
      key,
      target: el?.locator,
      description: reason,
      tags: [],
      risk: 'reversible',
      expect: this.checkpointFrom(before, after),
      timeoutMs: 8000,
    };
    this.steps.push(step);
    return step;
  }

  recordExtract(o: { output: string; source: Locator; parse: 'text' | 'currency' | 'number'; type: OutputSpec['type']; description?: string; sensitive?: boolean }) {
    const step: Step = {
      id: this.id('extract'),
      action: 'extract',
      output: o.output,
      source: o.source,
      parse: o.parse,
      description: o.description ?? `Read ${o.output}`,
      tags: [],
      risk: 'read',
      timeoutMs: 5000,
    };
    this.steps.push(step);
    if (!this.outputs.some((x) => x.name === o.output))
      this.outputs.push({ name: o.output, type: o.type, description: o.description ?? o.output, sensitive: o.sensitive ?? false });
    return step;
  }

  /** Tag the sign-in sequence: everything up to and including the first click after the last secret was typed. */
  tagAuthSteps() {
    const lastSecret = this.steps.map((s, i) => (s.action === 'type' && s.value.kind === 'secret' ? i : -1)).filter((i) => i >= 0).pop();
    if (lastSecret === undefined) return;
    let end = lastSecret;
    for (let i = lastSecret + 1; i < this.steps.length; i++) {
      if (this.steps[i].action === 'click' || this.steps[i].action === 'press') {
        end = i;
        break;
      }
    }
    for (let i = 0; i <= end; i++) this.steps[i].tags = Array.from(new Set([...this.steps[i].tags, 'auth']));
  }

  build(o: {
    capabilityId: string;
    name: string;
    description: string;
    whenToUse: string;
    notFor?: string;
    paramDescriptions: Record<string, string>;
    lastObservation: Observation;
    vendor: string;
    profile: string;
    tenantId?: string;
    versionObserved?: string;
    model: string;
    runId: string;
    evidenceRef: string;
  }): Capability {
    this.tagAuthSteps();
    const params: ParamSpec[] = Object.keys(this.ctx.params).map((name) => ({
      name,
      type: 'string',
      description: o.paramDescriptions[name] ?? name,
      required: true,
      sensitive: this.ctx.sensitiveParams.has(name),
      example: this.ctx.sensitiveParams.has(name) ? undefined : this.ctx.params[name],
    }));
    const maxRisk: RiskClass = this.steps.some((s) => s.risk === 'irreversible') ? 'irreversible' : this.steps.some((s) => s.risk === 'reversible') ? 'reversible' : 'read';
    const successConds: Condition[] = [];
    if (o.lastObservation.title) successConds.push({ kind: 'title', contains: this.canonicalize(o.lastObservation.title) });
    return {
      schemaVersion: SCHEMA_VERSION,
      id: o.capabilityId,
      name: o.name,
      version: '1.0.0',
      status: 'draft',
      description: o.description,
      usage: { whenToUse: o.whenToUse, notFor: o.notFor },
      app: { vendor: o.vendor, profile: o.profile, surface: 'web', entryUrl: this.ctx.entryUrl, recordedOnTenant: o.tenantId, versionObserved: o.versionObserved },
      params,
      outputs: this.outputs,
      steps: this.steps,
      success: { allOf: successConds.length ? successConds : [{ kind: 'url', pattern: '.*' }], timeoutMs: 5000 },
      detectors: [],
      overrides: [],
      policy: { maxRisk, requiresApproval: maxRisk === 'irreversible' },
      provenance: {
        recordedAt: new Date().toISOString(),
        recordedBy: 'discovery',
        model: o.model,
        discoveryRunId: o.runId,
        evidenceRef: o.evidenceRef,
        notes: 'Draft recorded by the discovery agent. Review locators and checkpoints, then set status to "approved" to allow unattended replay.',
      },
    };
  }
}

/** Escape regex metacharacters but keep {param} placeholders intact for later substitution. */
function escapeRegexKeepingParams(s: string) {
  return s
    .split(/(\{\w+\})/)
    .map((part) => (/^\{\w+\}$/.test(part) ? part : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
}
