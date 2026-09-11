/**
 * The Capability artifact: a typed, versioned, agent-invocable description of
 * a flow the model discovered once. This is the contract between the AI agent
 * (caller), the replay engine (executor) and the human reviewer (approver).
 *
 * Layering (see REPORT.md, "Heterogeneity & multi-tenant"):
 *   vendor app profile  ->  capability (base, recorded once)  ->  tenant overrides
 * The capability references an app profile for shared error detectors, and can
 * carry per-tenant overrides so it is not re-recorded per institution.
 */
import { z } from 'zod/v4';
import { Locator } from './locator.js';

export const SCHEMA_VERSION = '1.0';

// ---------- values ----------
/** Where a typed value comes from at replay time. Secrets are never stored. */
export const ValueRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string() }),
  z.object({ kind: z.literal('param'), name: z.string() }),
  /** Resolved from the environment / secret store at replay. Never logged, never persisted. */
  z.object({ kind: z.literal('secret'), name: z.string() }),
]);
export type ValueRef = z.infer<typeof ValueRef>;

export const ParamType = z.enum(['string', 'number', 'boolean']);

export const ParamSpec = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: ParamType,
  description: z.string(),
  required: z.boolean().default(true),
  /** Sensitive values are masked in logs/evidence (e.g. "***0001"). */
  sensitive: z.boolean().default(false),
  pattern: z.string().optional(),
  example: z.string().optional(),
});
export type ParamSpec = z.infer<typeof ParamSpec>;

export const OutputSpec = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: z.enum(['string', 'number', 'currency', 'boolean']),
  description: z.string(),
  sensitive: z.boolean().default(false),
});
export type OutputSpec = z.infer<typeof OutputSpec>;

// ---------- checkpoints ----------
/** A condition asserted to confirm the expected state was reached. All listed conditions must hold. */
export const Condition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), pattern: z.string().describe('Regex over the current URL; {param} placeholders allowed') }),
  z.object({ kind: z.literal('title'), contains: z.string() }),
  z.object({ kind: z.literal('text'), contains: z.string() }),
  z.object({ kind: z.literal('element'), locator: Locator }),
  z.object({ kind: z.literal('not-text'), contains: z.string() }),
]);
export type Condition = z.infer<typeof Condition>;

export const Checkpoint = z.object({
  allOf: z.array(Condition).min(1),
  timeoutMs: z.number().int().positive().default(8000),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

// ---------- steps ----------
export const RiskClass = z.enum(['read', 'reversible', 'irreversible']);
export type RiskClass = z.infer<typeof RiskClass>;

const StepBase = {
  id: z.string(),
  description: z.string(),
  /** Tags let recoveries re-run a subset (e.g. "auth" steps after a session expiry). */
  tags: z.array(z.string()).default([]),
  risk: RiskClass.default('read'),
  /** Post-condition verified after the action. */
  expect: Checkpoint.optional(),
  timeoutMs: z.number().int().positive().default(8000),
};

export const Step = z.discriminatedUnion('action', [
  z.object({ ...StepBase, action: z.literal('navigate'), url: z.string() }),
  z.object({ ...StepBase, action: z.literal('click'), target: Locator }),
  z.object({ ...StepBase, action: z.literal('type'), target: Locator, value: ValueRef, clear: z.boolean().default(true) }),
  z.object({ ...StepBase, action: z.literal('select'), target: Locator, value: ValueRef }),
  z.object({ ...StepBase, action: z.literal('press'), key: z.string(), target: Locator.optional() }),
  /** Read a value off the screen into a declared output. */
  z.object({
    ...StepBase,
    action: z.literal('extract'),
    output: z.string(),
    source: Locator,
    parse: z.enum(['text', 'currency', 'number']).default('text'),
  }),
  /** Pure assertion step (no action). */
  z.object({ ...StepBase, action: z.literal('assert'), checkpoint: Checkpoint }),
]);
export type Step = z.infer<typeof Step>;

// ---------- runtime-state detectors ----------
/** How to recognise a runtime condition on screen. */
export const Signature = z.object({
  anyOf: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('text'), contains: z.string() }),
        z.object({ kind: z.literal('title'), contains: z.string() }),
        z.object({ kind: z.literal('url'), pattern: z.string() }),
        z.object({ kind: z.literal('dialog'), messagePattern: z.string().optional() }),
        z.object({ kind: z.literal('http-status'), min: z.number(), max: z.number() }),
      ]),
    )
    .min(1),
});

export const Recovery = z.discriminatedUnion('action', [
  /** Dismiss a known interstitial by clicking a control, then retry the step. */
  z.object({ action: z.literal('click'), target: Locator }),
  /** Wait for a transient condition, then retry. */
  z.object({ action: z.literal('wait'), ms: z.number().int().positive() }),
  /** Re-run all steps carrying a tag (e.g. "auth" after session expiry), then retry. */
  z.object({ action: z.literal('rerun-tagged'), tag: z.string() }),
  /** Accept or dismiss a native dialog. */
  z.object({ action: z.literal('dialog'), response: z.enum(['accept', 'dismiss']) }),
]);
export type Recovery = z.infer<typeof Recovery>;

/**
 * The error taxonomy. Every detected condition is classified into exactly one of:
 *  - business_outcome: a legitimate answer the caller must handle ("no such member")
 *  - recoverable: a known condition the engine handles itself, then retries
 *  - hard_failure: stop, surface a debuggable error
 */
export const Classification = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('business_outcome'),
    code: z.string(),
    message: z.string(),
    /** Optionally pull structured detail off the screen (e.g. the validation message). */
    extract: z.array(z.object({ output: z.string(), source: Locator })).default([]),
  }),
  z.object({ type: z.literal('recoverable'), code: z.string(), recovery: Recovery, maxAttempts: z.number().int().positive().default(2) }),
  z.object({ type: z.literal('hard_failure'), code: z.string(), message: z.string() }),
  /** Not safe to decide automatically: hand to a human. */
  z.object({ type: z.literal('escalate'), code: z.string(), message: z.string() }),
]);
export type Classification = z.infer<typeof Classification>;

export const Detector = z.object({
  id: z.string(),
  description: z.string(),
  match: Signature,
  classify: Classification,
  /** Restrict to specific steps; omitted = global. */
  onlySteps: z.array(z.string()).optional(),
  /** Do not evaluate while executing steps carrying any of these tags (e.g. a "session lost" detector during "auth" steps). */
  excludeTags: z.array(z.string()).default([]),
});
export type Detector = z.infer<typeof Detector>;

// ---------- tenant overrides ----------
/** Per-tenant specialisation of a base capability, without re-recording. */
export const TenantOverride = z.object({
  tenantId: z.string(),
  description: z.string().optional(),
  entryUrl: z.string().optional(),
  /** Replace fields of an existing step by id (deep-merge one level). */
  patchSteps: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** Insert extra steps after a given step id. */
  insertSteps: z.array(z.object({ after: z.string(), step: Step })).default([]),
  /** Drop steps by id. */
  removeSteps: z.array(z.string()).default([]),
  extraDetectors: z.array(Detector).default([]),
});
export type TenantOverride = z.infer<typeof TenantOverride>;

// ---------- the capability ----------
export const CapabilityStatus = z.enum(['draft', 'approved', 'deprecated']);

export const Capability = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Stable identifier the calling agent uses (e.g. "coreserv.member.read_balances"). */
  id: z.string().regex(/^[a-z0-9_.-]+$/),
  name: z.string(),
  /** Semver of this artifact. Bump on any step/locator change. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: CapabilityStatus.default('draft'),
  description: z.string(),
  /** What the calling agent needs to know: when to use it and what it must not be used for. */
  usage: z.object({ whenToUse: z.string(), notFor: z.string().optional() }),

  app: z.object({
    /** Vendor product identity, shared across tenants running it. */
    vendor: z.string(),
    profile: z.string().describe('App profile id supplying shared detectors/auth steps'),
    surface: z.enum(['web', 'desktop']),
    entryUrl: z.string(),
    /** Tenant this was recorded on. */
    recordedOnTenant: z.string().optional(),
    versionObserved: z.string().optional(),
  }),

  params: z.array(ParamSpec),
  outputs: z.array(OutputSpec),
  steps: z.array(Step).min(1),
  /** Final success condition, verified after the last step. */
  success: Checkpoint,
  /** Capability-specific detectors; merged with the app profile's. */
  detectors: z.array(Detector).default([]),
  overrides: z.array(TenantOverride).default([]),

  policy: z.object({
    /** Highest risk class among the steps. */
    maxRisk: RiskClass,
    /** If true, an irreversible step will not execute without an explicit approval on the invocation. */
    requiresApproval: z.boolean(),
  }),

  provenance: z.object({
    recordedAt: z.string(),
    recordedBy: z.enum(['discovery', 'manual']),
    model: z.string().optional(),
    discoveryRunId: z.string().optional(),
    /** Path to the (redacted) discovery evidence, kept separate from the artifact. */
    evidenceRef: z.string().optional(),
    notes: z.string().optional(),
  }),
});
export type Capability = z.infer<typeof Capability>;

export function parseCapability(json: unknown): Capability {
  return Capability.parse(json);
}
