/**
 * Redaction: nothing reaches a log, transcript, artifact or result without
 * passing through here. Three layers:
 *   1. secret values (from env) are scrubbed wherever they appear
 *   2. sensitive param values are masked to their last 4 characters
 *   3. policy regexes (SSN, card, phone) are scrubbed from free text
 */
import type { Policy } from '../schema/policy.js';

export class Redactor {
  private secrets: string[] = [];
  private sensitiveValues: string[] = [];
  private patterns: { re: RegExp; replacement: string }[] = [];

  constructor(policy?: Policy) {
    if (policy) {
      for (const p of policy.redaction.patterns) this.patterns.push({ re: new RegExp(p.pattern, 'g'), replacement: p.replacement });
      for (const name of policy.redaction.secretNames) {
        const v = process.env[name];
        if (v) this.secrets.push(v);
      }
    }
  }

  addSecret(value: string) {
    if (value && !this.secrets.includes(value)) this.secrets.push(value);
  }
  addSensitiveValue(value: string) {
    if (value && value.length >= 4 && !this.sensitiveValues.includes(value)) this.sensitiveValues.push(value);
  }

  static mask(value: string): string {
    if (value.length <= 4) return '****';
    return '*'.repeat(Math.max(3, Math.min(6, value.length - 4))) + value.slice(-4);
  }

  text(input: string): string {
    let out = input;
    for (const s of this.secrets) out = out.split(s).join('[secret]');
    for (const v of this.sensitiveValues) out = out.split(v).join(Redactor.mask(v));
    for (const p of this.patterns) out = out.replace(p.re, p.replacement);
    return out;
  }

  /** Deep-redact any JSON-able value. Buffers are replaced by a size marker. */
  value<T>(input: T): T {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.text(v);
      if (Buffer.isBuffer(v)) return `[binary ${v.length} bytes]`;
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(input) as T;
  }
}
