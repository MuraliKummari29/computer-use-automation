import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureMockApp } from '../mock-app/server.js';
import { PlaywrightSurface } from '../src/surface/playwright.js';

let app: { close: () => Promise<void> };
let surface: PlaywrightSurface;

beforeAll(async () => {
  app = await ensureMockApp({ port: 4310, tenant: 'harbor' });
  surface = await PlaywrightSurface.launch({ headless: true });
  await surface.act({ type: 'navigate', url: 'http://localhost:4310/' });
  await surface.act({ type: 'type', target: { locator: { strategies: [{ kind: 'anchor', anchorText: 'Operator ID', relation: 'same-row', controlRole: 'textbox' }] } }, text: 'operator' });
  await surface.act({ type: 'type', target: { locator: { strategies: [{ kind: 'anchor', anchorText: 'Password', relation: 'same-row', controlRole: 'textbox' }] } }, text: 'demo123' });
  await surface.act({ type: 'click', target: { locator: { strategies: [{ kind: 'role', role: 'button', name: 'Sign In', exact: true }] } } });
  await surface.act({ type: 'type', target: { locator: { strategies: [{ kind: 'anchor', anchorText: 'Member Number', relation: 'same-row', controlRole: 'textbox' }] } }, text: '10003' });
  await surface.act({ type: 'click', target: { locator: { strategies: [{ kind: 'role', role: 'button', name: 'Find', exact: true }] } } });
});
afterAll(async () => {
  await surface.close();
  await app.close();
});

describe('surface: locator resolution on a legacy frameset', () => {
  it('reports how many visible controls a strategy matched (ambiguity signal)', async () => {
    // "Savings" (inexact) appears in several cells on the member summary: type column and nicknames.
    const loose = await surface.resolve({ strategies: [{ kind: 'text', text: 'Savings', exact: false }], frame: 'main' });
    expect(loose).not.toBeNull();
    expect(loose!.matches).toBeGreaterThan(1);
    // A table-cell locator is unambiguous.
    const tight = await surface.resolve({ strategies: [{ kind: 'table-cell', rowAnchor: 'Primary Savings', columnHeader: 'Balance' }], frame: 'main' });
    expect(tight!.matches).toBe(1);
    expect(await tight!.text()).toBe('$75,000.00');
  });
  it('falls through the bundle in order and reports which strategy resolved', async () => {
    const r = await surface.resolve({
      strategies: [
        { kind: 'role', role: 'button', name: 'Does Not Exist', exact: true },
        { kind: 'anchor', anchorText: 'No Such Label', relation: 'same-row', controlRole: 'textbox' },
        { kind: 'role', role: 'button', name: 'Open Sub-Account', exact: true },
      ],
      frame: 'main',
    });
    expect(r).toMatchObject({ index: 2, kind: 'role', frame: 'main', matches: 1 });
  });
  it('resolves the same control by role, by text and by bbox fallback', async () => {
    const byRole = await surface.resolve({ strategies: [{ kind: 'role', role: 'button', name: 'Card Services', exact: true }] });
    const box = await byRole!.bbox();
    const byBox = await surface.resolve({ strategies: [{ kind: 'bbox', ...box!, viewport: { w: 1280, h: 900 }, expectRole: 'button' }], frame: 'main' });
    expect(byBox).not.toBeNull();
    expect(await byBox!.text()).toBe(await byRole!.text());
    // and a bbox that points at nothing of the expected role does not resolve
    const miss = await surface.resolve({ strategies: [{ kind: 'bbox', x: 900, y: 700, w: 10, h: 10, viewport: { w: 1280, h: 900 }, expectRole: 'button' }], frame: 'main' });
    expect(miss).toBeNull();
  });
  it('observes every frame with marks and legacy label anchors', async () => {
    const o = await surface.observe();
    expect(o.frames.map((f) => f.name)).toEqual(expect.arrayContaining(['top', 'nav', 'main']));
    expect(o.elements.some((e) => e.frame === 'nav')).toBe(true);
    const btn = o.elements.find((e) => e.name === 'Open Sub-Account')!;
    expect(btn.locator.strategies[0]).toMatchObject({ kind: 'role', role: 'button' });
    expect(btn.locator.strategies.at(-1)!.kind).toBe('bbox');
    expect(o.text).not.toMatch(/^\d+$/m); // mark numbers never leak into detector text
  });
});
