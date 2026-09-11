/**
 * Deliberately legacy markup: framesets, table layout, <font> tags, generic
 * class names, no ids, no data-testids, labels not associated with inputs.
 * This is what a 2000s-era core banking console looks like.
 */
import type { TenantConfig } from './tenants.js';
import type { Member } from './data.js';

const esc = (s: string | number) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function frameset(t: TenantConfig) {
  return `<html><head><title>${esc(t.shortName)} - CoreServ</title></head>
<frameset rows="58,*" border="1" framespacing="0">
  <frame name="top" src="/frame/top" scrolling="no" noresize>
  <frameset cols="170,*">
    <frame name="nav" src="/frame/nav" scrolling="auto">
    <frame name="main" src="/app/login">
  </frameset>
</frameset></html>`;
}

export function topFrame(t: TenantConfig, user?: string) {
  return `<html><body bgcolor="${t.color}" style="margin:0">
<table width="100%" cellpadding="6" cellspacing="0"><tr>
<td><font color="#ffffff" size="4" face="Arial"><b>${esc(t.name)}</b></font>
<font color="#dddddd" size="2" face="Arial">&nbsp;&nbsp;Back Office Console</font></td>
<td align="right"><font color="#ffffff" size="2" face="Arial">${user ? 'Signed in as ' + esc(user) : 'Not signed in'}</font></td>
</tr></table></body></html>`;
}

export function navFrame(t: TenantConfig, signedIn: boolean) {
  const link = (href: string, text: string) =>
    `<tr><td class="c2"><a href="${href}" target="main"><font face="Arial" size="2">${text}</font></a></td></tr>`;
  return `<html><body bgcolor="#eeeeee" style="margin:0">
<table width="100%" cellpadding="5" cellspacing="0">
<tr><td class="c1"><font face="Arial" size="2" color="#666666"><b>MENU</b></font></td></tr>
${signedIn ? link('/app/search', 'Member Lookup') + link('/app/logout', 'Sign Out') : link('/app/login', 'Sign In')}
<tr><td class="c1"><font face="Arial" size="1" color="#999999">${esc(t.consoleVersion)}</font></td></tr>
</table></body></html>`;
}

function page(t: TenantConfig, title: string, body: string) {
  return `<html><head><title>${esc(title)}</title>
<style>
 body{font-family:Arial,Helvetica,sans-serif;font-size:12px;margin:12px;background:#fafafa}
 .c1{background:#e6e6e6} .c2{background:#ffffff} .c3{background:#fff3cd}
 .err{color:#a40000;font-weight:bold} .ok{color:#0a6b0a;font-weight:bold}
 table.grid td{border:1px solid #cccccc;padding:4px 8px}
 input,select{font-size:12px}
</style></head><body>
<table width="100%" cellspacing="0" cellpadding="4"><tr><td class="c1"><font size="3"><b>${esc(title)}</b></font></td></tr></table>
<br>
${body}
<br><br><hr size="1"><font size="1" color="#888888">${esc(t.consoleVersion)} &middot; ${esc(t.name)}</font>
</body></html>`;
}

export function loginPage(t: TenantConfig, opts: { error?: string; reason?: string } = {}) {
  const banner = opts.reason === 'expired'
    ? `<p class="err">Your session has expired. Please sign in again.</p>`
    : '';
  const err = opts.error ? `<p class="err">${esc(opts.error)}</p>` : '';
  return page(t, 'Operator Sign In', `${banner}${err}
<form method="post" action="/app/login">
<table cellpadding="4">
<tr><td>Operator ID</td><td><input type="text" name="user" size="20"></td></tr>
<tr><td>Password</td><td><input type="password" name="pass" size="20"></td></tr>
<tr><td></td><td><input type="submit" value="Sign In"></td></tr>
</table></form>`);
}

export function compliancePage(t: TenantConfig, next: string) {
  return page(t, 'Compliance Reminder', `
<table class="c3" width="520" cellpadding="8"><tr><td>
<b>Reminder:</b> All member record access is logged and audited under BSA/GLBA policy.
Only access records for a legitimate business purpose.
</td></tr></table>
<form method="post" action="/app/notice/ack"><input type="hidden" name="next" value="${esc(next)}">
<br><input type="submit" value="I Acknowledge"></form>`);
}

export function systemNoticePage(t: TenantConfig, next: string) {
  return page(t, 'System Notice', `
<table class="c3" width="520" cellpadding="8"><tr><td>
<b>Scheduled maintenance:</b> CoreServ will be unavailable tonight 11:00 PM - 1:00 AM CT.
</td></tr></table>
<form method="post" action="/app/notice/ack"><input type="hidden" name="next" value="${esc(next)}">
<br><input type="submit" value="Acknowledge"></form>`);
}

export function searchPage(t: TenantConfig, opts: { notFound?: string; error?: string } = {}) {
  const nf = opts.notFound
    ? `<p class="err">No member found for ${esc(t.memberLookupLabel)} ${esc(opts.notFound)}.</p>`
    : '';
  const err = opts.error ? `<p class="err">${esc(opts.error)}</p>` : '';
  return page(t, 'Member Lookup', `${nf}${err}
<form method="post" action="/app/search">
<table cellpadding="4">
<tr><td>${esc(t.memberLookupLabel)}</td><td><input type="text" name="q" size="16"></td>
<td><input type="submit" value="Find"></td></tr>
</table></form>
<font size="1" color="#888888">Enter the full ${esc(t.memberLookupLabel.toLowerCase())} and press Find.</font>`);
}

export function memberPage(t: TenantConfig, mem: Member, flash?: string) {
  const shares = mem.shares
    .map(
      (s) => `<tr><td>${esc(s.id)}</td><td>${esc(s.type)}</td><td>${esc(s.nickname)}</td>
<td align="right">${money(s.balance)}</td><td align="right">${money(s.available)}</td></tr>`,
    )
    .join('');
  const loans = mem.loans.length
    ? mem.loans
        .map(
          (l) => `<tr><td>${esc(l.id)}</td><td>${esc(l.type)}</td><td align="right">${money(l.balance)}</td>
<td align="right">${money(l.nextPayment)}</td><td>${esc(l.dueDate)}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="5"><i>No loans</i></td></tr>`;
  return page(t, `Member Summary - ${mem.number}`, `
${flash ? `<p class="ok">${esc(flash)}</p>` : ''}
<table cellpadding="3">
<tr><td><b>Name</b></td><td>${esc(mem.firstName)} ${esc(mem.lastName)}</td>
    <td width="30"></td><td><b>${esc(t.memberLookupLabel)}</b></td><td>${esc(mem.number)}</td></tr>
<tr><td><b>SSN</b></td><td>***-**-${esc(mem.ssnLast4)}</td>
    <td></td><td><b>Member Since</b></td><td>${esc(mem.memberSince)}</td></tr>
<tr><td><b>Phone</b></td><td>${esc(mem.phone)}</td><td></td><td><b>Address</b></td><td>${esc(mem.address)}</td></tr>
</table>
<br><font size="2"><b>Shares</b></font>
<table class="grid" cellspacing="0" width="640">
<tr class="c1"><td>ID</td><td>Type</td><td>Nickname</td><td align="right">Balance</td><td align="right">Available</td></tr>
${shares}</table>
<br><font size="2"><b>Loans</b></font>
<table class="grid" cellspacing="0" width="640">
<tr class="c1"><td>ID</td><td>Type</td><td align="right">Balance</td><td align="right">Next Payment</td><td>Due</td></tr>
${loans}</table>
<br>
<table cellpadding="4"><tr>
<td><form method="get" action="/app/member/${esc(mem.number)}/subaccount"><input type="submit" value="Open Sub-Account"></form></td>
<td><form method="get" action="/app/member/${esc(mem.number)}/cards"><input type="submit" value="Card Services"></form></td>
<td><form method="get" action="/app/search"><input type="submit" value="New Lookup"></form></td>
</tr></table>`);
}

export function subAccountForm(
  t: TenantConfig,
  mem: Member,
  products: { code: string; name: string; minDeposit: number }[],
  opts: { error?: string; values?: Record<string, string>; confirmDialog?: boolean } = {},
) {
  const v = opts.values ?? {};
  const options = products
    .map((p) => `<option value="${p.code}"${v.product === p.code ? ' selected' : ''}>${esc(p.name)} (min ${money(p.minDeposit)})</option>`)
    .join('');
  const onsubmit = opts.confirmDialog ? ` onsubmit="return confirm('Fees may apply to this product. Continue?')"` : '';
  return page(t, `Open Sub-Account - ${mem.number}`, `
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
<form method="post" action="/app/member/${esc(mem.number)}/subaccount"${onsubmit}>
<table cellpadding="4">
<tr><td>Product</td><td><select name="product"><option value="">-- select --</option>${options}</select></td></tr>
<tr><td>Nickname</td><td><input type="text" name="nickname" size="24" value="${esc(v.nickname ?? '')}"></td></tr>
<tr><td>Initial Deposit</td><td><input type="text" name="deposit" size="10" value="${esc(v.deposit ?? '')}"> <font size="1">from S05 Checking</font></td></tr>
<tr><td></td><td><input type="submit" value="Continue"> &nbsp; <a href="/app/member/${esc(mem.number)}">Cancel</a></td></tr>
</table></form>`);
}

export function subAccountConfirm(t: TenantConfig, mem: Member, pending: { product: string; productName: string; nickname: string; deposit: number }) {
  return page(t, 'Confirm Sub-Account', `
<p>Please review before committing. This action creates a new share and moves funds.</p>
<table class="grid" cellspacing="0">
<tr><td class="c1">Member</td><td>${esc(mem.number)} - ${esc(mem.firstName)} ${esc(mem.lastName)}</td></tr>
<tr><td class="c1">Product</td><td>${esc(pending.productName)}</td></tr>
<tr><td class="c1">Nickname</td><td>${esc(pending.nickname)}</td></tr>
<tr><td class="c1">Initial Deposit</td><td>${money(pending.deposit)} (from S05)</td></tr>
</table><br>
<form method="post" action="/app/member/${esc(mem.number)}/subaccount/commit">
<input type="submit" value="Confirm and Open"> &nbsp;
<a href="/app/member/${esc(mem.number)}/subaccount">Back</a>
</form>`);
}

export function subAccountDone(t: TenantConfig, mem: Member, shareId: string, confirmation: string) {
  return page(t, 'Sub-Account Opened', `
<p class="ok">Sub-account ${esc(shareId)} opened successfully.</p>
<table cellpadding="3">
<tr><td><b>Confirmation #</b></td><td>${esc(confirmation)}</td></tr>
<tr><td><b>New Share ID</b></td><td>${esc(shareId)}</td></tr>
</table><br>
<a href="/app/member/${esc(mem.number)}">Return to member summary</a>`);
}

export function cardsPage(t: TenantConfig, mem: Member, flash?: string) {
  const rows = mem.cards
    .map(
      (c) => `<tr><td>${esc(c.type)}</td><td>**** ${esc(c.last4)}</td><td>${esc(c.status)}</td>
<td>${c.status === 'Active' ? `<form method="post" action="/app/member/${esc(mem.number)}/cards/${esc(c.id)}/block"><input type="submit" value="Place Temporary Block"></form>` : '&nbsp;'}</td></tr>`,
    )
    .join('');
  return page(t, `Card Services - ${mem.number}`, `
${flash ? `<p class="ok">${esc(flash)}</p>` : ''}
<table class="grid" cellspacing="0" width="560">
<tr class="c1"><td>Type</td><td>Number</td><td>Status</td><td>Action</td></tr>${rows}</table>
<br><a href="/app/member/${esc(mem.number)}">Return to member summary</a>`);
}

export function cardBlockConfirm(t: TenantConfig, mem: Member, cardId: string, last4: string) {
  return page(t, 'Confirm Card Block', `
<p>Placing a temporary block on debit card ending <b>${esc(last4)}</b>. The member will not be able to use this card until the block is lifted.</p>
<form method="post" action="/app/member/${esc(mem.number)}/cards/${esc(cardId)}/block/commit">
<input type="submit" value="Confirm Block"> &nbsp; <a href="/app/member/${esc(mem.number)}/cards">Cancel</a>
</form>`);
}

export function notAuthorizedPage(t: TenantConfig) {
  return page(t, 'Not Authorized', `
<p class="err">You are not authorized to perform this action. Contact your supervisor to request the CARD_BLOCK permission.</p>
<a href="javascript:history.back()">Go back</a>`);
}

export function appErrorPage(t: TenantConfig, ref: string) {
  return page(t, 'Application Error', `
<p class="err">An unexpected error occurred while processing your request.</p>
<p>Reference: <tt>${esc(ref)}</tt></p>
<p>Please try again later or contact the help desk.</p>`);
}

export function notFoundPage(t: TenantConfig) {
  return page(t, 'Page Not Found', `<p class="err">The requested page does not exist.</p>`);
}
