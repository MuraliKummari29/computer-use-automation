/**
 * Policy guard: the single choke point every action passes through before it
 * reaches the surface, in discovery and in replay alike.
 */
import type { Policy } from '../schema/policy.js';
import type { RiskClass } from '../schema/capability.js';
import type { SurfaceAction } from '../surface/types.js';

export type GuardVerdict =
  | { allowed: true; risk: RiskClass; flagged?: string }
  | { allowed: false; reason: string; code: 'ORIGIN_NOT_ALLOWED' | 'PATH_NOT_ALLOWED' | 'ACTION_NOT_ALLOWED' | 'IRREVERSIBLE_BLOCKED' | 'IRREVERSIBLE_NEEDS_APPROVAL' };

export interface GuardContext {
  /** URL the surface is currently on. */
  currentUrl: string;
  /** Accessible name of the control being acted on, if any. */
  controlName?: string;
  /** Caller-supplied approval for irreversible actions on this invocation. */
  approveIrreversible?: boolean;
  /** Discovery runs are never allowed to execute irreversible actions unless the policy says so. */
  mode: 'discovery' | 'replay';
}

export class PolicyGuard {
  constructor(readonly policy: Policy) {}

  urlAllowed(url: string): { ok: true } | { ok: false; reason: string; code: 'ORIGIN_NOT_ALLOWED' | 'PATH_NOT_ALLOWED' } {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, reason: `unparseable url ${url}`, code: 'ORIGIN_NOT_ALLOWED' };
    }
    if (!this.policy.allowedOrigins.includes(u.origin)) return { ok: false, reason: `origin ${u.origin} not in allowlist`, code: 'ORIGIN_NOT_ALLOWED' };
    if (this.policy.deniedPaths.some((p) => new RegExp(p).test(u.pathname))) return { ok: false, reason: `path ${u.pathname} is denied`, code: 'PATH_NOT_ALLOWED' };
    if (this.policy.allowedPaths.length && !this.policy.allowedPaths.some((p) => new RegExp(p).test(u.pathname)))
      return { ok: false, reason: `path ${u.pathname} not in allowlist`, code: 'PATH_NOT_ALLOWED' };
    return { ok: true };
  }

  /** Classify the risk of an action from what it does and where it is done. */
  classify(action: SurfaceAction, ctx: Pick<GuardContext, 'currentUrl' | 'controlName'>): RiskClass {
    if (action.type === 'navigate' || action.type === 'wait') return 'read';
    if (action.type === 'type' || action.type === 'select') return 'reversible';
    const name = ctx.controlName ?? '';
    for (const m of this.policy.irreversible.matchers) {
      if (m.kind === 'control-name' && name && new RegExp(m.pattern).test(name)) return 'irreversible';
      if (m.kind === 'url') {
        try {
          if (new RegExp(m.pattern).test(new URL(ctx.currentUrl).pathname)) return 'irreversible';
        } catch {
          /* ignore */
        }
      }
    }
    // A click or keypress on something we cannot name: treat as reversible navigation.
    return action.type === 'click' || action.type === 'press' ? 'reversible' : 'read';
  }

  check(action: SurfaceAction, ctx: GuardContext): GuardVerdict {
    const target = action.type === 'navigate' ? action.url : ctx.currentUrl;
    const u = this.urlAllowed(target);
    if (!u.ok) return { allowed: false, reason: u.reason, code: u.code };
    if (!this.policy.allowedActions.includes(action.type)) return { allowed: false, reason: `action ${action.type} not allowed`, code: 'ACTION_NOT_ALLOWED' };
    const risk = this.classify(action, ctx);
    if (risk === 'irreversible') {
      if (ctx.mode === 'discovery' && !this.policy.discovery.allowIrreversible)
        return { allowed: false, reason: `irreversible action "${ctx.controlName}" is not executed during discovery; it is recorded for approved replay`, code: 'IRREVERSIBLE_BLOCKED' };
      const mode = this.policy.irreversible.mode;
      if (mode === 'block') return { allowed: false, reason: `irreversible action "${ctx.controlName}" blocked by policy`, code: 'IRREVERSIBLE_BLOCKED' };
      if (mode === 'require-approval' && !ctx.approveIrreversible)
        return { allowed: false, reason: `irreversible action "${ctx.controlName}" requires approval`, code: 'IRREVERSIBLE_NEEDS_APPROVAL' };
      return { allowed: true, risk, flagged: `irreversible action "${ctx.controlName}" executed under ${mode}` };
    }
    return { allowed: true, risk };
  }
}
