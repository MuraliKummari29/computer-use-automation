/**
 * App profile for the CoreServ vendor console.
 *
 * A profile is shared by every capability recorded against this vendor
 * product and by every tenant running it. It carries the knowledge that is
 * about the *app*, not about any one flow: how a session expiry looks, which
 * interstitials are safe to dismiss, what an application error looks like.
 * Capabilities reference it by id; tenant overrides can extend it.
 */
import type { Detector } from '../schema/capability.js';
import type { DialogRule } from '../surface/types.js';

export interface AppProfile {
  id: string;
  vendor: string;
  /** Evaluated in order after the capability's own detectors. First match wins. */
  detectors: Detector[];
  /** Native dialogs that are known and safe to answer automatically. Anything else escalates. */
  dialogRules: DialogRule[];
}

export const coreservProfile: AppProfile = {
  id: 'coreserv',
  vendor: 'CoreServ back-office console (mock legacy core)',
  dialogRules: [],
  detectors: [
    {
      id: 'session-expired',
      description: 'Session dropped; re-run the steps tagged "auth", then replay from the start.',
      match: { anyOf: [{ kind: 'text', contains: 'Your session has expired' }] },
      classify: { type: 'recoverable', code: 'SESSION_EXPIRED', recovery: { action: 'rerun-tagged', tag: 'auth' }, maxAttempts: 1 },
      excludeTags: ['auth'],
    },
    {
      id: 'system-notice',
      description: 'Maintenance notice interstitial; acknowledge and continue.',
      match: { anyOf: [{ kind: 'title', contains: 'System Notice' }] },
      classify: {
        type: 'recoverable',
        code: 'INTERSTITIAL_SYSTEM_NOTICE',
        recovery: { action: 'click', target: { strategies: [{ kind: 'role', role: 'button', name: 'Acknowledge', exact: true }] } },
        maxAttempts: 2,
      },
      excludeTags: [],
    },
    {
      id: 'compliance-reminder',
      description: 'Per-tenant compliance reminder shown after sign-in on some institutions; acknowledge and continue.',
      match: { anyOf: [{ kind: 'title', contains: 'Compliance Reminder' }] },
      classify: {
        type: 'recoverable',
        code: 'INTERSTITIAL_COMPLIANCE',
        recovery: { action: 'click', target: { strategies: [{ kind: 'role', role: 'button', name: 'I Acknowledge', exact: true }] } },
        maxAttempts: 2,
      },
      excludeTags: [],
    },
    {
      id: 'member-not-found',
      description: 'Lookup returned no member. A legitimate answer the caller must handle.',
      match: { anyOf: [{ kind: 'text', contains: 'No member found' }] },
      classify: { type: 'business_outcome', code: 'MEMBER_NOT_FOUND', message: '{matched}', extract: [] },
      excludeTags: [],
    },
    {
      id: 'validation-rejected',
      description: 'The app rejected submitted values.',
      match: {
        anyOf: [
          { kind: 'text', contains: 'must be at least' },
          { kind: 'text', contains: 'is required.' },
          { kind: 'text', contains: 'Insufficient available funds' },
          { kind: 'text', contains: 'Please select a product' },
        ],
      },
      classify: { type: 'business_outcome', code: 'VALIDATION_REJECTED', message: '{matched}', extract: [] },
      excludeTags: [],
    },
    {
      id: 'not-authorized',
      description: 'Operator lacks the permission for this action.',
      match: { anyOf: [{ kind: 'title', contains: 'Not Authorized' }] },
      classify: { type: 'business_outcome', code: 'PERMISSION_DENIED', message: '{matched}', extract: [] },
      excludeTags: [],
    },
    {
      id: 'app-error',
      description: 'The application itself failed. Nothing to recover; surface for debugging.',
      match: { anyOf: [{ kind: 'title', contains: 'Application Error' }, { kind: 'http-status', min: 500, max: 599 }] },
      classify: { type: 'hard_failure', code: 'APP_ERROR', message: 'Application error page: {matched}' },
      excludeTags: [],
    },
    {
      id: 'unknown-dialog',
      description: 'A native dialog we have no rule for. Not safe to decide automatically.',
      match: { anyOf: [{ kind: 'dialog' }] },
      classify: { type: 'escalate', code: 'UNEXPECTED_DIALOG', message: 'Unexpected dialog: {matched}' },
      excludeTags: [],
    },
    {
      id: 'login-page-unexpected',
      description: 'Landed on the sign-in page mid-flow without an expiry banner (e.g. after a redirect). Treat like an expiry.',
      match: { anyOf: [{ kind: 'title', contains: 'Operator Sign In' }] },
      classify: { type: 'recoverable', code: 'SESSION_LOST', recovery: { action: 'rerun-tagged', tag: 'auth' }, maxAttempts: 1 },
      excludeTags: ['auth'],
    },
  ],
};

export const APP_PROFILES: Record<string, AppProfile> = { coreserv: coreservProfile };
