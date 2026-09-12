/**
 * Convenience runner shared by the CLI, tests and the capability catalog:
 * load policy + capability, launch a surface, run the engine, tear down.
 */
import { readFileSync } from 'node:fs';
import { parseCapability, type Capability } from '../schema/capability.js';
import { Policy, type Policy as PolicyT } from '../schema/policy.js';
import type { ReplayResult } from '../schema/result.js';
import { PlaywrightSurface } from '../surface/playwright.js';
import { Redactor } from '../policy/redact.js';
import { RunEvidence, newRunId } from '../evidence/logger.js';
import { ReplayEngine } from './engine.js';
import type { OperatorChannel } from '../handoff/control.js';

export interface RunReplayOptions {
  capability: Capability | string;
  params: Record<string, string | number | boolean>;
  policy?: PolicyT | string;
  tenantId?: string;
  approval?: { approvedBy: string; reason: string };
  allowDraft?: boolean;
  headless?: boolean;
  operator?: OperatorChannel;
  evidenceRoot?: string;
  echo?: boolean;
  interventionTimeoutMs?: number;
  entryUrl?: string;
  /** Demo hook: inject a fault cookie into the mock app before the run starts. */
  fault?: string;
  /** Surface factory override (tests). */
  surface?: PlaywrightSurface;
}

export function loadPolicy(p: PolicyT | string = 'policies/coreserv.json'): PolicyT {
  return typeof p === 'string' ? Policy.parse(JSON.parse(readFileSync(p, 'utf8'))) : p;
}
export function loadCapability(c: Capability | string): Capability {
  return typeof c === 'string' ? parseCapability(JSON.parse(readFileSync(c, 'utf8'))) : c;
}

export async function runReplay(o: RunReplayOptions): Promise<ReplayResult> {
  const policy = loadPolicy(o.policy);
  const capability = loadCapability(o.capability);
  const redactor = new Redactor(policy);
  const evidence = new RunEvidence(newRunId('replay'), redactor, o.evidenceRoot ?? 'evidence', { echo: o.echo ?? true });
  const surface = o.surface ?? (await PlaywrightSurface.launch({ headless: o.headless ?? true }));
  try {
    if (o.fault) {
      const entry = o.entryUrl ?? capability.overrides.find((t) => t.tenantId === o.tenantId)?.entryUrl ?? capability.app.entryUrl;
      await surface.setCookie(entry, 'cs_fault', o.fault);
      evidence.warn('demo.fault_injected', { fault: o.fault });
    }
    const engine = new ReplayEngine({
      capability,
      params: o.params,
      tenantId: o.tenantId,
      approval: o.approval,
      allowDraft: o.allowDraft,
      policy,
      surface,
      evidence,
      redactor,
      operator: o.operator,
      interventionTimeoutMs: o.interventionTimeoutMs,
      entryUrl: o.entryUrl,
    });
    return await engine.run();
  } finally {
    if (!o.surface) await surface.close();
  }
}
