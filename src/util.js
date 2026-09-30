// 通用工具
export function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

export function now() {
  return new Date();
}

export function iso(d = new Date()) {
  return d.toISOString();
}

// 本地时间 YYYY-MM-DD HH:mm
export function fmt(d = new Date()) {
  if (typeof d === 'string') d = new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(d = new Date()) {
  if (typeof d === 'string') d = new Date(d);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function plusHours(h) {
  return new Date(Date.now() + h * 3600_000);
}

export function hoursAgo(h) {
  return new Date(Date.now() - h * 3600_000);
}

// 依据前缀与当日序号生成编号，如 FDM-20260930-0003
export function makeCode(prefix, seq, date = new Date()) {
  return `${prefix}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(seq, 4)}`;
}

export function parseJson(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
