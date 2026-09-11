/**
 * Operator channels.
 *
 * OperatorConsole: a minimal but real operator surface. An HTTP page lists the
 * pending intervention, shows the screenshot and context, and offers
 * Retry / Skip / Approve / Abort. The human performs manual steps directly in
 * the live (headed) browser window the automation is using; the surface
 * records those actions. This is deliberately bare: the seam (request ->
 * take control -> act -> hand back) is real, the UI is a stand-in.
 *
 * ScriptedOperator: for tests and unattended demos; resolves programmatically
 * and can drive the live surface to simulate the human's manual steps.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import type { InterventionRequest, InterventionResolution, OperatorChannel } from './control.js';
import type { Surface } from '../surface/types.js';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class OperatorConsole implements OperatorChannel {
  private pending = new Map<string, { req: InterventionRequest; resolve: (r: InterventionResolution) => void; taken: boolean; onTaken?: () => void }>();
  private history: { req: InterventionRequest; res: InterventionResolution }[] = [];
  private server?: ReturnType<express.Express['listen']>;
  readonly url: string;

  constructor(private port = 4400) {
    this.url = `http://localhost:${port}`;
  }

  async start() {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.get('/', (_req, res) => res.send(this.render()));
    app.get('/screenshot/:id', (req, res) => {
      const p = this.pending.get(String(req.params.id));
      if (!p?.req.screenshotPath) return res.status(404).end();
      res.type('png').send(readFileSync(p.req.screenshotPath));
    });
    app.post('/take/:id', (req, res) => {
      const p = this.pending.get(String(req.params.id));
      if (p && !p.taken) {
        p.taken = true;
        p.onTaken?.();
      }
      res.redirect('/');
    });
    app.post('/resolve/:id', (req, res) => {
      const p = this.pending.get(String(req.params.id));
      if (p) {
        const body = req.body as { resolution: string; operator?: string; notes?: string };
        const r: InterventionResolution = {
          resolution: body.resolution as InterventionResolution['resolution'],
          operator: body.operator || 'operator',
          notes: body.notes || undefined,
        };
        this.pending.delete(p.req.id);
        this.history.unshift({ req: p.req, res: r });
        p.resolve(r);
      }
      res.redirect('/');
    });
    app.get('/api/pending', (_req, res) => res.json([...this.pending.values()].map((p) => ({ ...p.req, taken: p.taken }))));
    await new Promise<void>((r) => {
      this.server = app.listen(this.port, () => r());
    });
  }

  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  request(req: InterventionRequest, opts: { timeoutMs: number; onTaken?: () => void }): Promise<InterventionResolution> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(req.id)) resolve({ resolution: 'timeout' });
      }, opts.timeoutMs);
      this.pending.set(req.id, {
        req,
        taken: false,
        onTaken: opts.onTaken,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      console.log(`\n>>> INTERVENTION NEEDED: open ${this.url} (request ${req.id}: ${req.code})\n`);
    });
  }

  private render() {
    const cards = [...this.pending.values()].map(({ req, taken }) => {
      const buttons = req.options
        .map((o) => `<button name="resolution" value="${o}" style="margin-right:8px;padding:6px 14px">${o[0].toUpperCase() + o.slice(1)}</button>`)
        .join('');
      return `<div style="border:1px solid #ccc;padding:16px;margin:12px 0;background:#fff">
<h3 style="margin:0 0 6px">${esc(req.code)} <small style="color:#666">${esc(req.id)}</small></h3>
<p><b>Capability:</b> ${esc(req.capabilityId)}<br><b>Goal:</b> ${esc(req.goal)}<br>
<b>Step:</b> ${esc(req.stepId)} — ${esc(req.stepDescription)}<br>
<b>Why it stopped:</b> ${esc(req.reason)}<br>
${req.expected ? `<b>Expected:</b> ${esc(req.expected)}<br>` : ''}${req.observed ? `<b>Observed:</b> ${esc(req.observed)}<br>` : ''}
<b>Live URL:</b> ${esc(req.url)}</p>
${req.screenshotPath ? `<img src="/screenshot/${esc(req.id)}" style="max-width:640px;border:1px solid #999">` : ''}
<p style="color:${taken ? '#0a6b0a' : '#a40000'}"><b>Control:</b> ${taken ? 'HUMAN (you have the live session; act in the browser window, then hand back below)' : 'waiting for a human to take control'}</p>
${
  taken
    ? ''
    : `<form method="post" action="/take/${esc(req.id)}"><button style="padding:6px 14px">Take control of live session</button></form>`
}
<form method="post" action="/resolve/${esc(req.id)}" style="margin-top:10px">
<label>Operator <input name="operator" value="operator"></label><br>
<label>Notes (what you did) <br><textarea name="notes" rows="3" cols="60"></textarea></label><br>
<p>Hand control back: ${buttons}</p>
<small>retry = re-run the current step · skip = mark it done and continue · approve = allow the irreversible action (or accept the reported dialog) and re-run · abort = stop the run</small>
</form></div>`;
    });
    const hist = this.history
      .slice(0, 10)
      .map((h) => `<li>${esc(h.req.id)} ${esc(h.req.code)} → <b>${esc(h.res.resolution)}</b> ${h.res.notes ? `(${esc(h.res.notes)})` : ''}</li>`)
      .join('');
    return `<html><head><title>Operator Console</title>${this.pending.size ? '' : '<meta http-equiv="refresh" content="2">'}
<style>body{font-family:Arial;background:#f3f3f3;margin:24px}</style></head><body>
<h2>Operator Console <small style="color:#666">(mock operator surface; the handoff is real)</small></h2>
${cards.length ? cards.join('') : '<p>No pending interventions. Automation is in control. <i>(auto-refreshing)</i></p>'}
<h4>Recent</h4><ul>${hist || '<li>none</li>'}</ul></body></html>`;
  }
}

/** Programmatic operator for tests and unattended demos. */
export class ScriptedOperator implements OperatorChannel {
  readonly requests: InterventionRequest[] = [];
  constructor(
    private script: (req: InterventionRequest, surface?: Surface) => Promise<InterventionResolution> | InterventionResolution,
    private surface?: Surface,
  ) {}
  async request(req: InterventionRequest, opts: { timeoutMs: number; onTaken?: () => void }): Promise<InterventionResolution> {
    this.requests.push(req);
    opts.onTaken?.();
    return this.script(req, this.surface);
  }
}
