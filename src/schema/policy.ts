/**
 * Safety policy: what the automation may touch and do.
 * Enforced on every action in both discovery and replay, before the action
 * reaches the surface. Configurable per app / tenant (policies/*.json).
 */
import { z } from 'zod/v4';

export const ActionType = z.enum(['navigate', 'click', 'type', 'select', 'press', 'extract', 'wait']);

export const IrreversibleMatcher = z.discriminatedUnion('kind', [
  /** Clicking a control whose accessible name matches this regex is irreversible. */
  z.object({ kind: z.literal('control-name'), pattern: z.string() }),
  /** Acting on a page whose URL matches this regex is irreversible. */
  z.object({ kind: z.literal('url'), pattern: z.string() }),
]);

export const Policy = z.object({
  id: z.string(),
  description: z.string().optional(),
  /** Origins the surface may navigate to or act within. Anything else is blocked. */
  allowedOrigins: z.array(z.string()).min(1),
  /** Regexes over the URL path. Empty = all paths on allowed origins. */
  allowedPaths: z.array(z.string()).default([]),
  /** Paths that may never be visited even on an allowed origin (e.g. admin, bulk export). */
  deniedPaths: z.array(z.string()).default([]),
  allowedActions: z.array(ActionType).min(1),
  irreversible: z.object({
    matchers: z.array(IrreversibleMatcher),
    /**
     * block:            never execute automatically
     * require-approval: execute only if the invocation carries approveIrreversible=true, else escalate
     * flag:             execute, but mark in evidence
     */
    mode: z.enum(['block', 'require-approval', 'flag']).default('require-approval'),
  }),
  discovery: z.object({
    maxSteps: z.number().int().positive().default(30),
    maxDurationMs: z.number().int().positive().default(10 * 60_000),
    /** Discovery may never execute irreversible actions itself; it records them for replay approval. */
    allowIrreversible: z.boolean().default(false),
  }),
  redaction: z.object({
    /** Regexes scrubbed from any text that reaches logs, transcripts or artifacts. */
    patterns: z.array(z.object({ name: z.string(), pattern: z.string(), replacement: z.string() })).default([]),
    /** Names of secrets (env vars) whose values are scrubbed if they ever appear. */
    secretNames: z.array(z.string()).default([]),
  }),
});
export type Policy = z.infer<typeof Policy>;
