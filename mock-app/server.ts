/**
 * CoreServ: a mock legacy core-banking back-office console.
 *
 * Stand-in for the vendor consoles (Symitar/Jack Henry style) that bank staff
 * operate by hand. Server-rendered, frameset-based, table layout, no ids.
 *
 * Runtime faults can be injected to exercise the replay engine's error
 * handling. Set them with GET /fault/<name> (sets a cookie) or by having the
 * automation set the `cs_fault` cookie directly. One-shot faults clear
 * themselves after firing so a recovery can proceed.
 *
 *   member_not_found   (natural: search for a number that does not exist)
 *   validation         (natural: deposit below product minimum)
 *   interstitial       one-shot system notice before the member summary
 *   slow               one-shot 4s delay on the member summary
 *   session_expired    one-shot: session dropped on next member summary load
 *   confirm_dialog     one-shot native confirm() on the sub-account form submit
 *   app_error          one-shot HTTP 500 on sub-account commit
 *   slow_commit        one-shot: sub-account commit takes effect immediately but responds after 20s (longer than settle + checkpoint)
 *   permission_denied  persistent: card block is refused
 *
 * State is in memory; POST /reset restores the seed data (used by tests and the evidence script).
 *
 * Usage: tsx mock-app/server.ts [--tenant harbor|summit] [--port 4310]
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TENANTS } from './tenants.js';
import { MEMBERS, OPERATORS, SUB_ACCOUNT_PRODUCTS, resetMembers } from './data.js';
import * as V from './views.js';

interface Session {
  user: string;
  pendingSubAccount?: { product: string; productName: string; nickname: string; deposit: number };
  complianceAcked: boolean;
}

export interface MockAppOptions {
  tenant?: string;
  port?: number;
  quiet?: boolean;
}

export function createApp(opts: MockAppOptions = {}) {
  const tenant = TENANTS[opts.tenant ?? 'harbor'];
  if (!tenant) throw new Error(`Unknown tenant: ${opts.tenant}`);
  const sessions = new Map<string, Session>();
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // --- tiny cookie helpers (no dependency) ---
  const cookies = (req: Request): Record<string, string> =>
    Object.fromEntries(
      (req.headers.cookie ?? '')
        .split(';')
        .map((c) => c.trim().split('='))
        .filter((kv) => kv.length === 2)
        .map(([k, v]) => [k, decodeURIComponent(v)]),
    );
  const setCookie = (res: Response, name: string, value: string) =>
    res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly`);
  const clearCookie = (res: Response, name: string) =>
    res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0`);

  const param = (req: Request, name: string) => String((req.params as Record<string, string | string[]>)[name] ?? '');

  // --- fault injection ---
  const fault = (req: Request) => cookies(req)['cs_fault'];
  const consumeFault = (req: Request, res: Response, name: string): boolean => {
    if (fault(req) !== name) return false;
    clearCookie(res, 'cs_fault');
    return true;
  };
  app.get('/fault/:name', (req, res) => {
    const name = param(req, 'name');
    if (name === 'clear') clearCookie(res, 'cs_fault');
    else setCookie(res, 'cs_fault', name);
    res.type('text').send(`fault=${name}`);
  });

  // --- session ---
  const sessionOf = (req: Request) => sessions.get(cookies(req)['cs_sid'] ?? '');
  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const s = sessionOf(req);
    if (!s) return res.redirect('/app/login?reason=expired');
    if (tenant.complianceInterstitialAfterLogin && !s.complianceAcked && !req.path.startsWith('/app/notice')) {
      return res.send(V.compliancePage(tenant, req.originalUrl));
    }
    (req as Request & { session: Session }).session = s;
    next();
  };
  const sess = (req: Request) => (req as Request & { session: Session }).session;

  // --- frames ---
  app.get('/', (_req, res) => res.send(V.frameset(tenant)));
  app.get('/frame/top', (req, res) => res.send(V.topFrame(tenant, sessionOf(req)?.user)));
  app.get('/frame/nav', (req, res) => res.send(V.navFrame(tenant, !!sessionOf(req))));
  const startedAt = Date.now();
  app.get('/health', (_req, res) => res.json({ ok: true, tenant: tenant.id, startedAt }));
  /** Test hook: read a member's state directly (denied to the agent by policy). */
  app.get('/debug/member/:n', (req, res) => {
    const mem = MEMBERS[param(req, 'n')];
    if (!mem) return res.status(404).json({ error: 'not found' });
    res.json({ shares: mem.shares.map((x) => x.id), cards: mem.cards.map((c) => ({ id: c.id, status: c.status })) });
  });
  /** Test hook: restore the seed data (state is in memory and mutated by writes). */
  app.post('/reset', (_req, res) => {
    resetMembers();
    res.json({ ok: true });
  });

  // --- auth ---
  app.get('/app/login', (req, res) => {
    res.send(V.loginPage(tenant, { reason: typeof req.query.reason === 'string' ? req.query.reason : undefined }));
  });
  app.post('/app/login', (req, res) => {
    const { user, pass } = req.body as { user?: string; pass?: string };
    const op = user ? OPERATORS[user] : undefined;
    if (!op || op.password !== pass) return res.send(V.loginPage(tenant, { error: 'Invalid operator ID or password.' }));
    const sid = randomBytes(12).toString('hex');
    sessions.set(sid, { user: user!, complianceAcked: false });
    setCookie(res, 'cs_sid', sid);
    res.redirect('/app/search');
  });
  app.get('/app/logout', (req, res) => {
    sessions.delete(cookies(req)['cs_sid'] ?? '');
    clearCookie(res, 'cs_sid');
    res.redirect('/app/login');
  });
  app.post('/app/notice/ack', (req, res) => {
    const s = sessionOf(req);
    if (s) s.complianceAcked = true;
    const next = typeof req.body.next === 'string' && req.body.next.startsWith('/') ? req.body.next : '/app/search';
    res.redirect(next);
  });

  // --- member lookup ---
  app.get('/app/search', requireSession, (_req, res) => res.send(V.searchPage(tenant)));
  app.post('/app/search', requireSession, (req, res) => {
    const q = String((req.body as { q?: string }).q ?? '').trim();
    if (!q) return res.send(V.searchPage(tenant, { error: `${tenant.memberLookupLabel} is required.` }));
    if (!MEMBERS[q]) return res.send(V.searchPage(tenant, { notFound: q }));
    res.redirect(`/app/member/${q}`);
  });

  app.get('/app/member/:n', requireSession, async (req, res) => {
    const mem = MEMBERS[param(req, 'n')];
    if (!mem) return res.status(404).send(V.notFoundPage(tenant));
    if (consumeFault(req, res, 'session_expired')) {
      sessions.delete(cookies(req)['cs_sid'] ?? '');
      clearCookie(res, 'cs_sid');
      return res.redirect('/app/login?reason=expired');
    }
    if (consumeFault(req, res, 'interstitial')) return res.send(V.systemNoticePage(tenant, req.originalUrl));
    if (consumeFault(req, res, 'slow')) await new Promise((r) => setTimeout(r, 4000));
    const flash = typeof req.query.flash === 'string' ? req.query.flash : undefined;
    res.send(V.memberPage(tenant, mem, flash));
  });

  // --- open sub-account (search -> detail -> form -> confirm -> commit) ---
  app.get('/app/member/:n/subaccount', requireSession, (req, res) => {
    const mem = MEMBERS[param(req, 'n')];
    if (!mem) return res.status(404).send(V.notFoundPage(tenant));
    const confirmDialog = consumeFault(req, res, 'confirm_dialog');
    res.send(V.subAccountForm(tenant, mem, SUB_ACCOUNT_PRODUCTS, { confirmDialog }));
  });
  app.post('/app/member/:n/subaccount', requireSession, (req, res) => {
    const mem = MEMBERS[param(req, 'n')];
    if (!mem) return res.status(404).send(V.notFoundPage(tenant));
    const body = req.body as Record<string, string>;
    const product = SUB_ACCOUNT_PRODUCTS.find((p) => p.code === body.product);
    const deposit = Number(body.deposit);
    const values = { product: body.product, nickname: body.nickname, deposit: body.deposit };
    if (!product) return res.send(V.subAccountForm(tenant, mem, SUB_ACCOUNT_PRODUCTS, { error: 'Please select a product.', values }));
    if (!body.nickname?.trim()) return res.send(V.subAccountForm(tenant, mem, SUB_ACCOUNT_PRODUCTS, { error: 'Nickname is required.', values }));
    if (!Number.isFinite(deposit) || deposit < product.minDeposit)
      return res.send(V.subAccountForm(tenant, mem, SUB_ACCOUNT_PRODUCTS, {
        error: `Initial deposit must be at least $${product.minDeposit.toFixed(2)} for ${product.name}.`,
        values,
      }));
    const checking = mem.shares.find((s) => s.id === 'S05')!;
    if (deposit > checking.available)
      return res.send(V.subAccountForm(tenant, mem, SUB_ACCOUNT_PRODUCTS, { error: 'Insufficient available funds in S05 Checking.', values }));
    sess(req).pendingSubAccount = { product: product.code, productName: product.name, nickname: body.nickname.trim(), deposit };
    res.redirect(`/app/member/${mem.number}/subaccount/confirm`);
  });
  app.get('/app/member/:n/subaccount/confirm', requireSession, (req, res) => {
    const mem = MEMBERS[param(req, 'n')];
    const pending = sess(req).pendingSubAccount;
    if (!mem || !pending) return res.redirect(`/app/member/${param(req, 'n')}/subaccount`);
    res.send(V.subAccountConfirm(tenant, mem, pending));
  });
  app.post('/app/member/:n/subaccount/commit', requireSession, async (req, res) => {
    const mem = MEMBERS[param(req, 'n')];
    const pending = sess(req).pendingSubAccount;
    if (!mem || !pending) return res.redirect(`/app/member/${param(req, 'n')}/subaccount`);
    if (consumeFault(req, res, 'app_error')) {
      return res.status(500).send(V.appErrorPage(tenant, 'ERR-' + randomBytes(3).toString('hex').toUpperCase()));
    }
    const slowCommit = consumeFault(req, res, 'slow_commit');
    const nextNum = mem.shares.length + 10;
    const shareId = `S${String(nextNum).padStart(2, '0')}`;
    const checking = mem.shares.find((s) => s.id === 'S05')!;
    checking.balance -= pending.deposit;
    checking.available -= pending.deposit;
    mem.shares.push({
      id: shareId,
      type: pending.product === 'MM' ? 'Money Market' : pending.product === 'CLUB' ? 'Club' : 'Savings',
      nickname: pending.nickname,
      balance: pending.deposit,
      available: pending.deposit,
    });
    sess(req).pendingSubAccount = undefined;
    const confirmation = 'CF' + Date.now().toString(36).toUpperCase();
    // The write has already happened above; a slow response is the dangerous case for a replayer.
    if (slowCommit) await new Promise((r) => setTimeout(r, 20000));
    res.send(V.subAccountDone(tenant, mem, shareId, confirmation));
  });

  // --- card services (permission-gated, irreversible-ish) ---
  app.get('/app/member/:n/cards', requireSession, (req, res) => {
    const mem = MEMBERS[param(req, 'n')];
    if (!mem) return res.status(404).send(V.notFoundPage(tenant));
    res.send(V.cardsPage(tenant, mem, typeof req.query.flash === 'string' ? req.query.flash : undefined));
  });
  app.post('/app/member/:n/cards/:cid/block', requireSession, (req, res) => {
    const mem = MEMBERS[param(req, 'n')];
    const card = mem?.cards.find((c) => c.id === param(req, 'cid'));
    if (!mem || !card) return res.status(404).send(V.notFoundPage(tenant));
    const op = OPERATORS[sess(req).user];
    if (!op.canBlockCards || fault(req) === 'permission_denied') return res.status(403).send(V.notAuthorizedPage(tenant));
    res.send(V.cardBlockConfirm(tenant, mem, card.id, card.last4));
  });
  app.post('/app/member/:n/cards/:cid/block/commit', requireSession, (req, res) => {
    const mem = MEMBERS[param(req, 'n')];
    const card = mem?.cards.find((c) => c.id === param(req, 'cid'));
    if (!mem || !card) return res.status(404).send(V.notFoundPage(tenant));
    const op = OPERATORS[sess(req).user];
    if (!op.canBlockCards || fault(req) === 'permission_denied') return res.status(403).send(V.notAuthorizedPage(tenant));
    card.status = 'Blocked';
    res.redirect(`/app/member/${mem.number}/cards?flash=${encodeURIComponent(`Temporary block placed on card ending ${card.last4}.`)}`);
  });

  app.use((_req, res) => res.status(404).send(V.notFoundPage(tenant)));
  return { app, tenant };
}

export function startMockApp(opts: MockAppOptions = {}) {
  const { app, tenant } = createApp(opts);
  const port = opts.port ?? Number(process.env.COMPUTER_USE_APP_PORT ?? 4310);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = app.listen(port, () => {
      const url = `http://localhost:${port}`;
      if (!opts.quiet) console.log(`[coreserv] tenant=${tenant.id} (${tenant.name}) listening on ${url}`);
      resolve({ url, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** Reuse a console already listening on the port (e.g. `npm run app` in another terminal), otherwise start one. */
export async function ensureMockApp(opts: MockAppOptions & { port: number }) {
  const url = `http://localhost:${opts.port}`;
  const health = await fetch(`${url}/health`).then((r) => (r.ok ? (r.json() as Promise<{ startedAt?: number }>) : null)).catch(() => null);
  if (health) {
    // A console started before the mock app's source last changed would silently run stale code.
    const here = dirname(fileURLToPath(import.meta.url));
    const newest = Math.max(...['server.ts', 'views.ts', 'data.ts', 'tenants.ts'].map((f) => statSync(join(here, f)).mtimeMs));
    if (!health.startedAt || health.startedAt < newest)
      throw new Error(`a console is already listening on ${url} but was started before mock-app/ last changed; restart it (npm run app) so tests and evidence run against current code`);
    const reset = await fetch(`${url}/reset`, { method: 'POST' }).then((r) => r.ok).catch(() => false);
    if (!reset) throw new Error(`a console is already listening on ${url} but does not support POST /reset; restart it (npm run app)`);
    return { url, close: async () => {}, reused: true };
  }
  return { ...(await startMockApp({ ...opts, quiet: opts.quiet ?? true })), reused: false };
}

// CLI entry
const isMain = process.argv[1] && /mock-app[\\/]server\.ts$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  startMockApp({ tenant: get('--tenant'), port: get('--port') ? Number(get('--port')) : undefined });
}
