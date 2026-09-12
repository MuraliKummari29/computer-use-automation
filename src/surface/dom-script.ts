/**
 * In-page scripts executed inside each frame. They must be self-contained
 * (Playwright serialises the function source). Nothing here leaks into the
 * artifact: data-cu-* attributes are transient handles cleared on every observe.
 */

export interface RawElement {
  mark: number;
  role: string;
  name: string;
  tag: string;
  inputType?: string;
  value?: string;
  enabled: boolean;
  bbox: { x: number; y: number; w: number; h: number };
  /** Text of a nearby label cell when the control has no accessible name of its own. */
  anchor?: { text: string; relation: 'same-row' | 'right-of' };
  ownText?: string;
  /** Where the name came from. Only 'accessible' names are usable for role+name lookup. */
  nameSource: 'accessible' | 'anchor' | 'attribute' | 'none';
}

/** Collect interactive elements, tag them with data-cu-mark, draw numbered overlays. */
export function collectAndMark(arg: { startMark: number; draw: boolean }): RawElement[] {
  const out: RawElement[] = [];
  const doc = document;
  doc.querySelectorAll('[data-cu-mark]').forEach((e) => e.removeAttribute('data-cu-mark'));
  doc.querySelectorAll('.__cu_overlay').forEach((e) => e.remove());

  const roleOf = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('role');
    if (aria) return aria;
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (['submit', 'button', 'image', 'reset'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    if (el.hasAttribute('onclick')) return 'button';
    return 'unknown';
  };
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const cellLabel = (el: Element): { text: string; relation: 'same-row' | 'right-of' } | undefined => {
    const td = el.closest('td,th');
    if (!td) return undefined;
    let prev = td.previousElementSibling;
    while (prev && !clean(prev.textContent)) prev = prev.previousElementSibling;
    const txt = clean(prev?.textContent);
    if (txt && txt.length < 60) return { text: txt, relation: 'same-row' };
    return undefined;
  };
  type NameSource = 'accessible' | 'anchor' | 'attribute' | 'none';
  const nameOf = (el: Element, role: string): [string, NameSource] => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return [aria, 'accessible'];
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const inp = el as HTMLInputElement;
      const t = (inp.type || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return [clean(inp.value) || 'Submit', 'accessible'];
      if (t === 'image') return [clean(inp.alt) || 'image button', 'accessible'];
      const ph = clean(inp.placeholder);
      if (ph) return [ph, 'accessible'];
    }
    if (tag === 'img') return [clean(el.getAttribute('alt')), 'accessible'];
    if (role === 'link' || role === 'button' || role === 'cell' || role === 'heading') {
      const t = clean((el as HTMLElement).innerText ?? el.textContent);
      if (t) return [t, 'accessible'];
    }
    const title = clean(el.getAttribute('title'));
    if (title) return [title, 'accessible'];
    // Real <label for> / wrapping label are part of the accessible name.
    const id = el.getAttribute('id');
    if (id) {
      const lab = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab) return [clean(lab.textContent), 'accessible'];
    }
    const wrap = el.closest('label');
    if (wrap) return [clean(wrap.textContent), 'accessible'];
    // Legacy: no programmatic label. A neighbouring cell is the human-visible label.
    const anchor = cellLabel(el);
    if (anchor) return [anchor.text, 'anchor'];
    const attr = clean(el.getAttribute('name'));
    return attr ? [attr, 'attribute'] : ['', 'none'];
  };

  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[onclick]';
  let mark = arg.startMark;
  const overlay = doc.createElement('div');
  overlay.className = '__cu_overlay';
  overlay.setAttribute('style', 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none');

  doc.querySelectorAll(sel).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return;
    const role = roleOf(el);
    const [name, nameSource] = nameOf(el, role);
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : undefined;
    let value: string | undefined;
    if (tag === 'input' && role === 'textbox') {
      const raw = (el as HTMLInputElement).value;
      value = inputType === 'password' ? (raw ? '••••' : '') : raw;
    }
    if (tag === 'select') {
      const s = el as HTMLSelectElement;
      value = s.selectedOptions[0]?.text ?? '';
    }
    const enabled = !(el as HTMLInputElement).disabled;
    el.setAttribute('data-cu-mark', String(mark));
    const ownText = role === 'link' || role === 'button' ? clean((el as HTMLElement).innerText) : undefined;
    out.push({
      mark,
      role,
      name,
      tag,
      inputType,
      value,
      enabled,
      nameSource,
      bbox: { x: r.left, y: r.top, w: r.width, h: r.height },
      anchor: role === 'textbox' || role === 'combobox' || role === 'checkbox' || role === 'radio' ? cellLabel(el) : undefined,
      ownText,
    });
    if (arg.draw) {
      const box = doc.createElement('div');
      box.setAttribute(
        'style',
        `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
          'outline:2px solid #e11d48;outline-offset:-1px;box-sizing:border-box',
      );
      const lab = doc.createElement('div');
      lab.textContent = String(mark);
      lab.setAttribute(
        'style',
        `position:fixed;left:${Math.max(0, r.left - 2)}px;top:${Math.max(0, r.top - 16)}px;` +
          'background:#e11d48;color:#fff;font:bold 11px/14px Arial;padding:0 4px;border-radius:2px',
      );
      overlay.appendChild(box);
      overlay.appendChild(lab);
    }
    mark++;
  });
  if (arg.draw) doc.body.appendChild(overlay);
  return out;
}

export function clearMarks(): void {
  document.querySelectorAll('.__cu_overlay').forEach((e) => e.remove());
}

export function visibleText(): string {
  return (document.body?.innerText ?? '').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Resolve a semantic legacy locator in-page. Tags the found element with
 * data-cu-resolved=<token> and returns true. Supports: anchor, table-cell,
 * labeled-value, bbox.
 */
export function resolveInPage(arg: {
  token: string;
  strategy:
    | { kind: 'anchor'; anchorText: string; relation: 'same-row' | 'right-of' | 'below'; controlRole: string }
    | { kind: 'table-cell'; rowAnchor: string; columnHeader: string }
    | { kind: 'labeled-value'; label: string }
    | { kind: 'bbox'; x: number; y: number; w: number; h: number; viewport: { w: number; h: number }; expectRole?: string; frameOffset: { x: number; y: number }; currentViewport: { w: number; h: number } };
}): boolean {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  document.querySelectorAll('[data-cu-resolved]').forEach((e) => e.removeAttribute('data-cu-resolved'));
  const tag = (el: Element) => {
    el.setAttribute('data-cu-resolved', arg.token);
    return true;
  };
  const roleSelector = (role: string) => {
    switch (role) {
      case 'textbox':
        return 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=image]),textarea';
      case 'combobox':
        return 'select';
      case 'button':
        return 'button,input[type=submit],input[type=button],input[type=image],[role=button]';
      case 'link':
        return 'a[href],[role=link]';
      case 'checkbox':
        return 'input[type=checkbox]';
      case 'radio':
        return 'input[type=radio]';
      default:
        return 'a[href],button,input:not([type=hidden]),select,textarea';
    }
  };
  /** Elements whose own direct text equals `text` (exact, trimmed). Prefers the innermost element. */
  const textOwners = (text: string): Element[] => {
    const res: Element[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (clean(n.textContent) === text && n.parentElement) res.push(n.parentElement);
    }
    if (res.length) return res;
    // Fallback: containing cells (for labels that wrap markup like <b>)
    return Array.from(document.querySelectorAll('td,th,label,span,div,b')).filter((e) => clean(e.textContent) === text && e.children.length <= 2);
  };
  const s = arg.strategy;

  if (s.kind === 'anchor') {
    for (const owner of textOwners(s.anchorText)) {
      const cell = owner.closest('td,th') ?? owner;
      const or = cell.getBoundingClientRect();
      if (s.relation === 'same-row') {
        const row = cell.closest('tr');
        if (!row) continue;
        const controls = Array.from(row.querySelectorAll(roleSelector(s.controlRole)));
        const after = controls.filter((c) => cell.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (after[0]) return tag(after[0]);
      } else {
        let best: Element | null = null;
        let bestD = Infinity;
        for (const c of Array.from(document.querySelectorAll(roleSelector(s.controlRole)))) {
          const r = c.getBoundingClientRect();
          if (r.width < 2) continue;
          const cy = r.top + r.height / 2;
          const cx = r.left + r.width / 2;
          const ok =
            s.relation === 'right-of'
              ? cy >= or.top - 4 && cy <= or.bottom + 4 && r.left >= or.right - 2
              : cx >= or.left - 4 && cx <= or.right + 4 && r.top >= or.bottom - 2;
          if (!ok) continue;
          const d = s.relation === 'right-of' ? r.left - or.right : r.top - or.bottom;
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        if (best) return tag(best);
      }
    }
    return false;
  }

  if (s.kind === 'table-cell') {
    for (const table of Array.from(document.querySelectorAll('table'))) {
      const rows = Array.from(table.querySelectorAll(':scope > tbody > tr, :scope > tr'));
      if (rows.length < 2) continue;
      const header = rows.find((r) => Array.from(r.children).some((c) => clean(c.textContent) === s.columnHeader));
      if (!header) continue;
      const col = Array.from(header.children).findIndex((c) => clean(c.textContent) === s.columnHeader);
      for (const r of rows) {
        if (r === header) continue;
        const cells = Array.from(r.children);
        if (cells.some((c) => clean(c.textContent) === s.rowAnchor) && cells[col]) return tag(cells[col]);
      }
    }
    return false;
  }

  if (s.kind === 'labeled-value') {
    for (const owner of textOwners(s.label)) {
      const cell = owner.closest('td,th');
      if (!cell) continue;
      let next = cell.nextElementSibling;
      while (next && !clean(next.textContent)) next = next.nextElementSibling;
      if (next) return tag(next);
    }
    return false;
  }

  if (s.kind === 'bbox') {
    // Recorded boxes are in main-viewport coordinates; scale by the *main* viewport (not this frame's size),
    // then translate into this frame's coordinate space.
    const sx = s.currentViewport.w / s.viewport.w;
    const sy = s.currentViewport.h / s.viewport.h;
    const cx = (s.x + s.w / 2) * sx - s.frameOffset.x;
    const cy = (s.y + s.h / 2) * sy - s.frameOffset.y;
    const el = document.elementFromPoint(cx, cy);
    if (!el) return false;
    const ctl = el.closest('a[href],button,input,select,textarea,td,th') ?? el;
    if (s.expectRole && s.expectRole !== 'unknown') {
      if (!ctl.matches(roleSelector(s.expectRole))) return false;
    }
    return tag(ctl);
  }
  return false;
}

/** Record human actions during a handoff. Posts to window.__cuHuman (exposed binding). */
export function installHumanRecorder(): void {
  const w = window as unknown as { __cuHuman?: (e: { kind: string; detail: string }) => void; __cuInstalled?: boolean };
  if (w.__cuInstalled || !w.__cuHuman) return;
  w.__cuInstalled = true;
  const describe = (el: Element | null) => {
    if (!el) return 'unknown';
    const t = el.tagName.toLowerCase();
    const name =
      el.getAttribute('aria-label') ||
      (el as HTMLInputElement).value ||
      (el as HTMLElement).innerText?.trim().slice(0, 40) ||
      el.getAttribute('name') ||
      '';
    return `${t}${name ? ` "${name}"` : ''}`;
  };
  document.addEventListener('click', (e) => w.__cuHuman!({ kind: 'click', detail: describe(e.target as Element) }), true);
  document.addEventListener(
    'change',
    (e) => {
      const el = e.target as HTMLInputElement;
      const secret = el.type === 'password';
      w.__cuHuman!({ kind: 'input', detail: `${describe(el)} = ${secret ? '••••' : el.value}` });
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') w.__cuHuman!({ kind: 'keypress', detail: e.key });
  }, true);
}
