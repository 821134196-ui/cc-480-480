import { api, state, actor, ROLE_LABEL } from './api.js';

// ---------- 通用 DOM ----------
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
}

export function badge(label, cls) {
  return el('span', { class: `badge ${cls}` }, label);
}

export function fmtDT(s) {
  if (!s) return '—';
  const d = new Date(s);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer;
const toastEl = () => document.getElementById('toast');
export function toast(msg, kind = '') {
  const t = toastEl();
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

export async function modal({ title, body, footer }) {
  const mask = el('div', { class: 'modal-mask' });
  const close = () => mask.remove();
  const m = el('div', { class: 'modal', onclick: e => e.stopPropagation() },
    el('header', {}, title, el('span', { class: 'x', onclick: close }, '✕')),
    el('div', { class: 'body' }, body),
    footer ? el('footer', {}, footer) : null,
  );
  mask.append(m);
  mask.addEventListener('click', close);
  document.body.append(mask);
  return { mask, close };
}

export function requireRole(roles, msg = '当前操作人无权执行该操作') {
  const a = actor();
  if (!a) { toast('请先在右上角选择操作人', 'err'); return false; }
  if (!roles.includes(a.role)) { toast(msg, 'err'); return false; }
  return true;
}

export async function wrap(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    toast(e.message, 'err');
    throw e;
  }
}

export { api, state, ROLE_LABEL };
