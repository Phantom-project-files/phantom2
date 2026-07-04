/* Phantom 2.0 — shared client helpers (no framework, no build).
   Trimmed port of v1's phantom.js: DOM + fetch helpers, inline SVG icons
   (never emoji), toast, nav state, version stamp. The v1 session plumbing
   (/api/session), help modal and dev pills are NOT ported — 2.0 uses
   /api/me + Google OAuth and has no dev-bypass surface.
   Usage: <script src="assets/phantom.js"></script> then data-icon="name" on <i>. */
(function () {
  'use strict';
  const P = (window.Phantom = window.Phantom || {});

  // ---- DOM ----
  P.$ = (s, r = document) => r.querySelector(s);
  P.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  P.el = (tag, props = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v != null) n.setAttribute(k, v);
    }
    (Array.isArray(kids) ? kids : [kids]).forEach((c) => c != null && n.append(c.nodeType ? c : document.createTextNode(c)));
    return n;
  };

  // ---- fetch ----
  P.api = async (path, opts = {}) => {
    const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts,
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
    const txt = await res.text();
    let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
  };
  P.fmt = (n) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US');
  P.kfmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n ?? '—');

  // ---- icons (Lucide-style, 24-grid, stroke=currentColor) ----
  const I = {
    'arrow-right': '<path d="M5 12h14M13 5l7 7-7 7"/>', 'arrow-left': '<path d="M19 12H5M11 19l-7-7 7-7"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>', 'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    check: '<path d="M20 6L9 17l-5-5"/>', 'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>', sparkles: '<path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4L12 3zM19 14l.9 2.3L22 17l-2.1.7L19 20l-.9-2.3L16 17l2.1-.7L19 14z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    play: '<path d="M6 4l14 8-14 8V4z"/>', download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/>',
    youtube: '<rect x="2.5" y="5" width="19" height="14" rx="4"/><path d="M10 9l5 3-5 3V9z" fill="currentColor" stroke="none"/>',
    tiktok: '<path d="M14 4v9.5a3.5 3.5 0 1 1-3-3.46"/><path d="M14 4a4.5 4.5 0 0 0 4.5 4.5"/>',
    google: '<path d="M21 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.1a4.4 4.4 0 0 1-1.9 2.9v2.4h3.1c1.8-1.7 2.7-4.1 2.7-7.1z" fill="#fff" stroke="none"/><path d="M12 21c2.4 0 4.5-.8 6-2.2l-3.1-2.4c-.8.6-1.9 1-2.9 1-2.3 0-4.2-1.5-4.9-3.6H3.9v2.5A9 9 0 0 0 12 21z" fill="#fff" stroke="none"/><path d="M7.1 13.8a5.4 5.4 0 0 1 0-3.6V7.7H3.9a9 9 0 0 0 0 8.6l3.2-2.5z" fill="#fff" stroke="none"/><path d="M12 6.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 3.9 7.7l3.2 2.5C7.8 8.1 9.7 6.6 12 6.6z" fill="#fff" stroke="none"/>',
    star: '<path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.8 6.2 21.9l1.1-6.5L2.6 9.8l6.5-.9L12 3z"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
    zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    lock: '<rect x="4.5" y="10" width="15" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  };
  P.icon = (name, size = 20) => {
    const p = I[name] || I.dot;
    const colored = /fill="#/.test(p); // google etc. carry their own fills
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ${colored ? '' : 'stroke="currentColor"'} stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  };
  P.mountIcons = (root = document) => P.$$('[data-icon]', root).forEach((n) => {
    if (n.dataset.mounted) return; n.innerHTML = P.icon(n.dataset.icon, n.dataset.size || 20); n.dataset.mounted = '1'; n.style.display = 'inline-flex';
  });

  // ---- toast ----
  P.toast = (msg, type = '') => {
    let wrap = P.$('.toast-wrap'); if (!wrap) { wrap = P.el('div', { class: 'toast-wrap' }); document.body.append(wrap); }
    const ic = type === 'ok' ? 'check-circle' : type === 'err' ? 'x' : 'sparkles';
    const t = P.el('div', { class: 'toast ' + type, html: P.icon(ic, 18) + `<span>${msg}</span>` });
    wrap.append(t); setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3200);
  };

  // ---- nav active state by filename ----
  P.markNav = () => { const f = location.pathname.split('/').pop() || 'index.html';
    P.$$('[data-nav]').forEach((a) => { if (a.dataset.nav === f) a.classList.add('active'); }); };

  // Operator shortcut (v1 port): top-center "Operator console" pill on every page
  // when an admin session exists (probes /admin/auth/me). Skipped on the console +
  // operator sign-in page so it never doubles up.
  P.mountAdminDashboard = () => {
    if (document.getElementById('phantomAdminDashBtn')) return;
    const here = location.pathname.split('/').pop();
    if (['admin.html', 'admin-login.html'].includes(here)) return;
    fetch('/admin/auth/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.success) return;
        const btn = P.el('a', {
          id: 'phantomAdminDashBtn',
          href: '/app/admin.html',
          'aria-label': 'Operator console',
          style: 'position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:95; ' +
                 'display:inline-flex; align-items:center; gap:7px; height:36px; padding:0 18px; ' +
                 'border-radius:99px; background:linear-gradient(180deg,#9D86FF,#7C5CFF); color:#fff; ' +
                 'text-decoration:none; font-weight:600; font-size:.82rem; ' +
                 'box-shadow:0 8px 22px -8px rgba(124,92,255,.75), 0 0 0 1px rgba(124,92,255,.4);',
          html: P.icon('grid', 16) + '<span>Operator console</span>',
        });
        document.body.appendChild(btn);
      })
      .catch(() => { /* best-effort */ });
  };

  // Light version stamp (bottom-center) so you can tell which build is live.
  P.mountVersion = () => {
    if (document.getElementById('phantomVer')) return;
    fetch('/version', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.version || document.getElementById('phantomVer')) return;
        document.body.appendChild(P.el('div', {
          id: 'phantomVer',
          style: 'position:fixed; bottom:8px; left:50%; transform:translateX(-50%); z-index:50; ' +
                 'font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace; color:rgba(255,255,255,.3); ' +
                 'letter-spacing:.04em; pointer-events:none; user-select:none;',
          text: 'v' + d.version + (d.sha ? ' · ' + String(d.sha).slice(0, 7) : ''),
        }));
      })
      .catch(() => {});
  };

  P.ready = (fn) => {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  };

  P.ready(() => { P.mountIcons(); P.markNav(); P.mountVersion(); P.mountAdminDashboard(); P.$$('[data-year]').forEach((n) => (n.textContent = new Date().getFullYear())); });
})();
