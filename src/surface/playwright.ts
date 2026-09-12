/**
 * PlaywrightSurface: the web implementation of the Surface seam.
 *
 * Perception: screenshot + set-of-marks over every frame (framesets included),
 * built from the accessibility-ish view of each element, not from CSS paths.
 * Action: by mark (discovery), by locator bundle (replay), or by point.
 */
import { chromium, type Browser, type BrowserContext, type Frame, type Locator as PwLocator, type Page } from 'playwright';
import type { Locator, LocatorStrategy } from '../schema/locator.js';
import { collectAndMark, clearMarks, installHumanRecorder, resolveInPage, visibleText, type RawElement } from './dom-script.js';
import type { DialogEvent, DialogRule, MarkedElement, Observation, Resolved, Surface, SurfaceAction, Target } from './types.js';

export interface PlaywrightSurfaceOptions {
  headless?: boolean;
  viewport?: { w: number; h: number };
  slowMo?: number;
}

interface ResolvedInternal extends Resolved {
  pw: PwLocator;
}

const ROLE_TO_ARIA: Record<string, string> = {
  button: 'button',
  link: 'link',
  textbox: 'textbox',
  combobox: 'combobox',
  checkbox: 'checkbox',
  radio: 'radio',
  cell: 'cell',
  heading: 'heading',
  image: 'img',
};


/**
 * Evaluate a typed in-page function by source. tsx/esbuild inject a `__name`
 * helper into serialised functions which does not exist inside the page; we
 * ship the source with a shim instead of relying on Playwright's serialiser.
 */
async function evalIn<A, R>(frame: Frame, fn: (arg: A) => R, arg?: A): Promise<R> {
  const src = fn.toString().replace(/__name\((\w+),\s*"[^"]*"\)/g, '$1');
  const expr = `(() => { const __name = (f) => f; return (${src})(${arg === undefined ? '' : JSON.stringify(arg)}); })()`;
  return frame.evaluate(expr) as Promise<R>;
}

export class PlaywrightSurface implements Surface {
  readonly kind = 'web' as const;
  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;
  private dialogRules: DialogRule[] = [];
  private pendingDialogs: DialogEvent[] = [];
  private lastStatus?: number;
  private markFrames = new Map<number, Frame>();
  private viewport: { w: number; h: number };
  private recordingHuman = false;
  private humanSink?: (e: { kind: string; detail: string }) => void;
  private tokenSeq = 0;

  constructor(private opts: PlaywrightSurfaceOptions = {}) {
    this.viewport = opts.viewport ?? { w: 1280, h: 900 };
  }

  static async launch(opts: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
    const s = new PlaywrightSurface(opts);
    await s.init();
    return s;
  }

  private async init() {
    this.browser = await chromium.launch({ headless: this.opts.headless ?? true, slowMo: this.opts.slowMo });
    this.context = await this.browser.newContext({ viewport: { width: this.viewport.w, height: this.viewport.h } });
    await this.context.tracing.start({ screenshots: true, snapshots: true });
    this.page = await this.context.newPage();
    this.page.on('dialog', async (d) => {
      if (this.recordingHuman) {
        // A Playwright-driven session cannot show native dialogs to the human; accept and record on their behalf.
        this.humanSink?.({ kind: 'note', detail: `native ${d.type()} "${d.message()}" accepted while human in control` });
        await d.accept();
        return;
      }
      const rule = this.dialogRules.find((r) => new RegExp(r.pattern, 'i').test(d.message()));
      const response = rule?.response ?? 'dismiss';
      this.pendingDialogs.push({ type: d.type(), message: d.message(), response, matchedRule: rule?.pattern });
      if (response === 'accept') await d.accept();
      else await d.dismiss();
    });
    this.page.on('response', (r) => {
      if (r.request().resourceType() === 'document') this.lastStatus = r.status();
    });
    await this.page.exposeBinding('__cuHuman', (_src, e: { kind: string; detail: string }) => {
      if (this.recordingHuman) this.humanSink?.(e);
    });
    this.page.on('framenavigated', async (f) => {
      if (this.recordingHuman) await evalIn(f, installHumanRecorder).catch(() => {});
    });
  }

  // ---------- frames ----------
  private framePath(frame: Frame): string {
    const parts: string[] = [];
    let f: Frame | null = frame;
    while (f && f.parentFrame()) {
      parts.unshift(f.name() || '?');
      f = f.parentFrame();
    }
    return parts.length ? parts.join('/') : '(root)';
  }

  private async frameOffset(frame: Frame): Promise<{ x: number; y: number }> {
    if (!frame.parentFrame()) return { x: 0, y: 0 };
    try {
      const el = await frame.frameElement();
      const box = await el.boundingBox();
      return box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  }

  /** The frame the user is "looking at": the largest child frame, or the root when there are none. */
  private async primaryFrame(): Promise<Frame> {
    const frames = this.page.frames().filter((f) => f.parentFrame());
    let best: Frame = this.page.mainFrame();
    let bestArea = -1;
    for (const f of frames) {
      try {
        const box = await (await f.frameElement()).boundingBox();
        const area = box ? box.width * box.height : 0;
        if (area > bestArea) {
          bestArea = area;
          best = f;
        }
      } catch {
        /* detached */
      }
    }
    return best;
  }

  private orderedFrames(hint?: string): Frame[] {
    const all = this.page.frames();
    if (!hint) return all;
    return [...all.filter((f) => this.framePath(f) === hint), ...all.filter((f) => this.framePath(f) !== hint)];
  }

  private async settle(timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    await this.page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
    while (Date.now() < deadline) {
      let ready = true;
      for (const f of this.page.frames()) {
        const state = await f.evaluate(() => document.readyState).catch(() => 'loading');
        if (state !== 'complete') ready = false;
      }
      if (ready) break;
      await this.page.waitForTimeout(100);
    }
    await this.page.waitForTimeout(120);
  }

  // ---------- Surface ----------
  async observe(opts: { marks?: boolean } = {}): Promise<Observation> {
    const draw = opts.marks ?? true;
    await this.settle(2000);
    const elements: MarkedElement[] = [];
    const frames: Observation['frames'] = [];
    const textParts: string[] = [];
    this.markFrames.clear();
    let mark = 1;
    for (const frame of this.page.frames()) {
      const path = this.framePath(frame);
      let raw: RawElement[] = [];
      try {
        textParts.push(`[frame ${path}]\n` + (await evalIn(frame, visibleText).catch(() => '')));
        raw = await evalIn(frame, collectAndMark, { startMark: mark, draw });
        frames.push({ name: path, url: frame.url(), title: await frame.title().catch(() => '') });
      } catch {
        continue;
      }
      const off = await this.frameOffset(frame);
      for (const r of raw) {
        const bbox = { x: r.bbox.x + off.x, y: r.bbox.y + off.y, w: r.bbox.w, h: r.bbox.h };
        elements.push({
          mark: r.mark,
          role: (r.role in ROLE_TO_ARIA || r.role === 'text' ? r.role : 'unknown') as MarkedElement['role'],
          name: r.name,
          frame: path,
          bbox,
          value: r.value,
          enabled: r.enabled,
          locator: this.bundleFor(r, path, bbox),
        });
        this.markFrames.set(r.mark, frame);
        mark = r.mark + 1;
      }
    }
    const screenshotPng = await this.page.screenshot({ type: 'png' });
    if (draw) for (const f of this.page.frames()) await evalIn(f, clearMarks).catch(() => {});
    const primary = await this.primaryFrame();
    return {
      at: new Date().toISOString(),
      screenshotPng,
      viewport: this.viewport,
      url: primary.url(),
      title: await primary.title().catch(() => ''),
      frames,
      elements,
      text: textParts.join('\n\n'),
      dialogs: this.pendingDialogs.splice(0),
      lastStatus: this.lastStatus,
    };
  }

  /** Build the locator bundle for an observed element, most robust first. */
  private bundleFor(r: RawElement, frame: string, bbox: MarkedElement['bbox']): Locator {
    const strategies: LocatorStrategy[] = [];
    const role = (r.role in ROLE_TO_ARIA ? r.role : 'unknown') as LocatorStrategy extends { role: infer R } ? R : never;
    if (r.name && role !== 'unknown' && r.nameSource === 'accessible') strategies.push({ kind: 'role', role, name: r.name, exact: true });
    if (r.ownText && r.ownText !== r.name) strategies.push({ kind: 'text', text: r.ownText, exact: true });
    if (r.anchor && role !== 'unknown') strategies.push({ kind: 'anchor', anchorText: r.anchor.text, relation: r.anchor.relation, controlRole: role });
    strategies.push({ kind: 'bbox', ...bbox, viewport: this.viewport, expectRole: role });
    const rationale = r.anchor
      ? `Legacy form control without a programmatic label; "${r.anchor.text}" is the adjacent label cell.`
      : r.name
        ? `Accessible ${r.role} named "${r.name}".`
        : 'No accessible name; spatial fallback only.';
    return { strategies, frame, rationale };
  }

  private async targetToLocator(t: Target): Promise<PwLocator | null> {
    if ('mark' in t) {
      const frame = this.markFrames.get(t.mark);
      if (!frame) return null;
      return frame.locator(`[data-cu-mark="${t.mark}"]`).first();
    }
    if ('locator' in t) {
      const r = (await this.resolve(t.locator)) as ResolvedInternal | null;
      return r?.pw ?? null;
    }
    return null;
  }

  async act(action: SurfaceAction): Promise<void> {
    switch (action.type) {
      case 'navigate':
        await this.page.goto(action.url, { waitUntil: 'load' });
        break;
      case 'wait':
        await this.page.waitForTimeout(action.ms);
        break;
      case 'press': {
        const loc = action.target ? await this.targetToLocator(action.target) : null;
        if (loc) await loc.press(action.key);
        else await this.page.keyboard.press(action.key);
        break;
      }
      case 'click': {
        if ('point' in action.target) {
          await this.page.mouse.click(action.target.point.x, action.target.point.y);
          break;
        }
        const loc = await this.targetToLocator(action.target);
        if (!loc) throw new Error('target not found');
        await loc.click({ timeout: 5000 });
        break;
      }
      case 'type': {
        if ('point' in action.target) {
          await this.page.mouse.click(action.target.point.x, action.target.point.y);
          await this.page.keyboard.type(action.text);
          break;
        }
        const loc = await this.targetToLocator(action.target);
        if (!loc) throw new Error('target not found');
        if (action.clear ?? true) await loc.fill(action.text, { timeout: 5000 });
        else await loc.pressSequentially(action.text, { timeout: 5000 });
        break;
      }
      case 'select': {
        if ('point' in action.target) throw new Error('select by point unsupported');
        const loc = await this.targetToLocator(action.target);
        if (!loc) throw new Error('target not found');
        try {
          await loc.selectOption({ label: action.value }, { timeout: 3000 });
        } catch {
          await loc.selectOption({ value: action.value }, { timeout: 3000 });
        }
        break;
      }
    }
    await this.settle();
  }

  async resolve(locator: Locator): Promise<Resolved | null> {
    const frames = this.orderedFrames(locator.frame);
    for (let i = 0; i < locator.strategies.length; i++) {
      const s = locator.strategies[i];
      for (const frame of frames) {
        const hit = await this.tryStrategy(frame, s).catch(() => null);
        if (!hit) continue;
        const pw = hit.first;
        const r: ResolvedInternal = {
          index: i,
          kind: s.kind,
          frame: this.framePath(frame),
          matches: hit.count,
          pw,
          text: async () => (await pw.innerText().catch(() => pw.textContent()))?.trim() ?? '',
          bbox: async () => {
            const b = await pw.boundingBox();
            return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
          },
        };
        return r;
      }
    }
    return null;
  }

  private async tryStrategy(frame: Frame, s: LocatorStrategy): Promise<{ first: PwLocator; count: number } | null> {
    let loc: PwLocator | null = null;
    switch (s.kind) {
      case 'role': {
        const aria = ROLE_TO_ARIA[s.role];
        if (!aria) return null;
        loc = frame.getByRole(aria as Parameters<Frame['getByRole']>[0], { name: s.name, exact: s.exact });
        break;
      }
      case 'text':
        loc = frame.getByText(s.text, { exact: s.exact });
        break;
      case 'css':
        loc = frame.locator(s.selector);
        break;
      case 'anchor':
      case 'table-cell':
      case 'labeled-value':
      case 'bbox': {
        const token = `t${++this.tokenSeq}`;
        const strategy = s.kind === 'bbox' ? { ...s, frameOffset: await this.frameOffset(frame), currentViewport: this.viewport } : s;
        const ok = await evalIn(frame, resolveInPage, { token, strategy });
        if (!ok) return null;
        loc = frame.locator(`[data-cu-resolved="${token}"]`);
        break;
      }
    }
    if (!loc) return null;
    const count = await loc.count();
    if (count === 0) return null;
    // Prefer the first *visible* candidate; report how many matched so the engine can flag ambiguity.
    let visible = 0;
    let first: PwLocator | null = null;
    for (let i = 0; i < count; i++) {
      const c = loc.nth(i);
      if (await c.isVisible().catch(() => false)) {
        visible++;
        first ??= c;
      }
    }
    return first ? { first, count: visible } : null;
  }

  async peek(opts: { drainDialogs?: boolean } = {}) {
    const primary = await this.primaryFrame();
    const parts: string[] = [];
    for (const f of this.page.frames()) parts.push(await evalIn(f, visibleText).catch(() => ''));
    return {
      url: primary.url(),
      title: await primary.title().catch(() => ''),
      text: parts.join('\n'),
      dialogs: opts.drainDialogs ? this.pendingDialogs.splice(0) : [...this.pendingDialogs],
      lastStatus: this.lastStatus,
    };
  }

  setDialogRules(rules: DialogRule[]) {
    this.dialogRules = rules;
  }

  currentOrigin(): string {
    try {
      return new URL(this.page.url()).origin;
    } catch {
      return '';
    }
  }

  async saveTrace(path: string) {
    await this.context.tracing.stop({ path });
    await this.context.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: 'png' });
  }

  // ---------- handoff support ----------
  async startHumanRecording(sink: (e: { kind: string; detail: string }) => void) {
    this.humanSink = sink;
    this.recordingHuman = true;
    for (const f of this.page.frames()) await evalIn(f, installHumanRecorder).catch(() => {});
    await this.page.bringToFront().catch(() => {});
  }
  stopHumanRecording() {
    this.recordingHuman = false;
  }

  /** Set a cookie on the app origin (used by the demo to inject faults into the mock app). */
  async setCookie(url: string, name: string, value: string) {
    await this.context.addCookies([{ name, value, url }]);
  }

  async close() {
    await this.context.tracing.stop().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}
