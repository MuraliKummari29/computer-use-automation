/**
 * Evidence: one directory per run under evidence/<runId>/ containing
 *   run.jsonl        structured, redacted event log (what happened and why)
 *   step-NN.png      screenshot after each step (both discovery and replay)
 *   failure.png      the screen at the moment of failure
 *   trace.zip        Playwright trace on failure (rich signal, gitignored)
 *   result.json      the ReplayResult / discovery summary
 *   intervention-*.json  handoff requests and what the human did
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Redactor } from '../policy/redact.js';

export interface LogEvent {
  at: string;
  runId: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  [k: string]: unknown;
}

export function newRunId(prefix: string) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${prefix}-${ts}-${randomBytes(2).toString('hex')}`;
}

export class RunEvidence {
  readonly dir: string;
  readonly logPath: string;
  private shots = 0;

  constructor(
    readonly runId: string,
    private redactor: Redactor,
    root = 'evidence',
    private opts: { echo?: boolean; screenshots?: boolean } = {},
  ) {
    this.dir = join(root, runId);
    mkdirSync(this.dir, { recursive: true });
    this.logPath = join(this.dir, 'run.jsonl');
    writeFileSync(this.logPath, '');
  }

  log(event: string, data: Record<string, unknown> = {}, level: LogEvent['level'] = 'info') {
    const e: LogEvent = this.redactor.value({ at: new Date().toISOString(), runId: this.runId, level, event, ...data });
    appendFileSync(this.logPath, JSON.stringify(e) + '\n');
    if (this.opts.echo ?? true) {
      const { at, runId, level: lv, event: ev, ...rest } = e;
      void at;
      void runId;
      const tag = lv === 'info' ? ' ' : lv === 'warn' ? '!' : 'X';
      const summary = Object.entries(rest)
        .filter(([, v]) => typeof v !== 'object' || v === null)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
        .join(' ');
      console.log(`[${tag}] ${ev} ${summary}`.slice(0, 220));
    }
  }
  warn(event: string, data: Record<string, unknown> = {}) {
    this.log(event, data, 'warn');
  }
  error(event: string, data: Record<string, unknown> = {}) {
    this.log(event, data, 'error');
  }

  screenshot(png: Buffer, label?: string): string | undefined {
    if (this.opts.screenshots === false) return undefined;
    const name = label ? `${label}.png` : `step-${String(++this.shots).padStart(2, '0')}.png`;
    const p = join(this.dir, name);
    writeFileSync(p, png);
    return p;
  }

  json(name: string, data: unknown) {
    const p = join(this.dir, name);
    writeFileSync(p, JSON.stringify(this.redactor.value(data), null, 2));
    return p;
  }
}
