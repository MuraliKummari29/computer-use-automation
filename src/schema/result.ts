/**
 * The replay result contract returned to the calling agent.
 *
 * Three top-level outcomes, deliberately distinct:
 *   success          the flow completed and the checkpoint held; outputs are present
 *   business_outcome the app gave a legitimate, expected answer that is not "done"
 *                    (member not found, validation rejected, permission denied)
 *   failure          something went wrong that the caller cannot act on except by
 *                    debugging: locator not found, checkpoint failed, app error,
 *                    intervention aborted. Carries step, expected, observed, evidence.
 *
 * Recoverable conditions never surface at the top level; they are visible in
 * the per-step report (status "recovered") and in the run log.
 */
import { z } from 'zod/v4';

export const StepStatus = z.enum(['ok', 'recovered', 'failed', 'skipped', 'escalated']);

export const StepReport = z.object({
  stepId: z.string(),
  action: z.string(),
  status: StepStatus,
  attempts: z.number().int(),
  durationMs: z.number(),
  /** Which locator strategy resolved the target (index into the bundle + kind). */
  resolvedBy: z.object({ index: z.number(), kind: z.string() }).optional(),
  /** True when a lower-ranked strategy had to be used: a UI drift signal, not a failure. */
  drift: z.boolean().default(false),
  /** Set when the resolving strategy matched more than one visible control; the first was used. Review the locator. */
  ambiguous: z.number().int().optional(),
  recoveries: z.array(z.object({ detectorId: z.string(), code: z.string(), action: z.string() })).default([]),
  screenshot: z.string().optional(),
  note: z.string().optional(),
});
export type StepReport = z.infer<typeof StepReport>;

export const HumanAction = z.object({
  at: z.string(),
  kind: z.enum(['click', 'input', 'navigate', 'keypress', 'note']),
  detail: z.string(),
});
export type HumanAction = z.infer<typeof HumanAction>;

export const InterventionRecord = z.object({
  id: z.string(),
  requestedAt: z.string(),
  resolvedAt: z.string().optional(),
  stepId: z.string(),
  reason: z.string(),
  code: z.string(),
  screenshot: z.string().optional(),
  operator: z.string().optional(),
  resolution: z.enum(['retry', 'skip', 'abort', 'approve', 'timeout']).optional(),
  notes: z.string().optional(),
  humanActions: z.array(HumanAction).default([]),
});
export type InterventionRecord = z.infer<typeof InterventionRecord>;

const ResultBase = {
  runId: z.string(),
  capabilityId: z.string(),
  capabilityVersion: z.string(),
  tenantId: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  steps: z.array(StepReport),
  interventions: z.array(InterventionRecord).default([]),
  evidenceDir: z.string(),
};

export const ReplayResult = z.discriminatedUnion('status', [
  z.object({
    ...ResultBase,
    status: z.literal('success'),
    outputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  z.object({
    ...ResultBase,
    status: z.literal('business_outcome'),
    code: z.string(),
    message: z.string(),
    /** Any outputs gathered before the outcome, plus detector-extracted detail. */
    outputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    detectorId: z.string(),
    stepId: z.string(),
  }),
  z.object({
    ...ResultBase,
    status: z.literal('failure'),
    code: z.string(),
    message: z.string(),
    stepId: z.string().optional(),
    expected: z.string().optional(),
    observed: z.string().optional(),
    evidence: z.object({ screenshot: z.string().optional(), trace: z.string().optional(), log: z.string() }),
  }),
]);
export type ReplayResult = z.infer<typeof ReplayResult>;

export const FailureCodes = {
  LOCATOR_NOT_FOUND: 'LOCATOR_NOT_FOUND',
  CHECKPOINT_FAILED: 'CHECKPOINT_FAILED',
  SUCCESS_CHECK_FAILED: 'SUCCESS_CHECK_FAILED',
  APP_ERROR: 'APP_ERROR',
  UNEXPECTED_DIALOG: 'UNEXPECTED_DIALOG',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  RECOVERY_EXHAUSTED: 'RECOVERY_EXHAUSTED',
  INTERVENTION_ABORTED: 'INTERVENTION_ABORTED',
  INTERVENTION_TIMEOUT: 'INTERVENTION_TIMEOUT',
  MISSING_PARAM: 'MISSING_PARAM',
  EXTRACT_FAILED: 'EXTRACT_FAILED',
  SURFACE_ERROR: 'SURFACE_ERROR',
} as const;
