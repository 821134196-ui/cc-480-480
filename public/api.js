// API 封装：操作人通过 x-actor-id 头传递
const STORE_KEY = 'firedoor.actorId';

export const state = {
  actorId: Number(localStorage.getItem(STORE_KEY) || 0) || null,
  users: [],
};

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers['content-type'] = 'application/json';
  if (state.actorId) headers['x-actor-id'] = state.actorId;
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body instanceof FormData ? opts.body
      : opts.body ? JSON.stringify({ actorId: state.actorId, ...opts.body }) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, error: { message: '响应解析失败' } }));
  if (!res.ok || !json.ok) {
    const err = new Error(json.error?.message || `请求失败 ${res.status}`);
    err.code = json.error?.code;
    err.status = res.status;
    throw err;
  }
  return json.data;
}

export function setActor(id) {
  state.actorId = id || null;
  if (id) localStorage.setItem(STORE_KEY, String(id));
  else localStorage.removeItem(STORE_KEY);
}

export function actor() {
  return state.users.find(u => u.id === state.actorId) || null;
}

export const ROLE_LABEL = {
  inspector: '巡检员', repair: '维修工', safety_manager: '安全主管', admin: '管理员',
};

export const DOOR_STATUS_LABEL = {
  normal: '正常', pending_repair: '待维修', repairing: '维修中', temp_blocked: '临时封控',
  await_reset: '待复位', reset_failed: '复位退回', decommissioned: '停用',
};

export const FAULT_STATUS_LABEL = {
  open: '待维修', repairing: '维修中', temp_blocked: '临时封控',
  await_reset: '待复位', reset_failed: '复位退回', closed: '已关闭',
};

export const FAULT_KIND_LABEL = {
  wedged: '门体被楔开', speed_fast: '闭门过快', seq_error: '双扇顺序错误',
  no_signal: '信号无回传', inaccessible: '无法进入', reset_fail: '复位失败', other: '其他缺陷',
};

export const EVENT_LABEL = {
  wedged: '门体被楔开', close_fast: '闭门过快', seq_error: '顺序错误', no_signal: '信号无回传',
  inaccessible: '现场无法进入', repair_overdue: '维修超时', reset_fail: '复位失败',
  temp_approved: '临时措施批准', temp_expired: '临时措施到期', repair_done: '维修完工',
  reset_pass: '复位合格', decommission: '门体停用', reactivate: '门体恢复', inspection_due: '巡检提醒',
};

export const SEAL_LABEL = { none: '无封堵', partial: '部分封堵', sealed: '完全封堵', temp: '临时封堵' };

export const RESET_ITEM_LABEL = {
  door_leaf: '门扇完好', frame: '门框完好', close_speed: '闭门速度合格',
  sequence: '双扇顺序正确', release_linkage: '电磁释放联动',
};
