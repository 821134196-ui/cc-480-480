/* 防火门巡检与复位系统 — 单页前端（原生 JS） */
'use strict';

const api = async (path, body) => {
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify(body) } : {};
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
};

const state = { meta: null, view: 'map', meId: Number(localStorage.getItem('meId') || 0),
                selectedZone: null, pollTimer: null };
const VIEWS = {};

const ROLE_LABELS = { inspector: '巡检员', repairer: '维修工', supervisor: '安全主管', manager: '物业经理' };
const STATUS_LABELS = { normal: '正常', pending_repair: '待维修', temp_controlled: '临时封控', decommissioned: '停用' };
const DOOR_TYPE = { normally_open: '常开', normally_closed: '常闭' };
const ORDER_STATUS = { open: '待开工', in_progress: '维修中', awaiting_reset: '待复位', done: '已完成', cancelled: '已取消' };
const TASK_STATUS = { pending: '待执行', in_progress: '执行中', done: '已完成', skipped: '已跳过' };
const COMP_LABELS = { closer: '闭门器', sequencer: '顺序器', em_release: '电磁释放' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const me = () => state.meta.users.find(u => u.id === state.meId) || null;
const doorById = id => state.meta.doors.find(d => d.id === id);
const zoneById = id => state.meta.zones.find(z => z.id === id);
const fmtDt = s => s ? s.replace('T', ' ').slice(0, 16) : '—';
const faultText = t => state.meta.constants.fault_labels[t] || t;
const isOverdue = (s, due) => s !== 'done' && s !== 'cancelled' && due && due < new Date().toISOString();

function toast(msg, kind = 'info') {
  const div = document.createElement('div');
  div.className = `toast ${kind}`;
  div.textContent = msg;
  document.getElementById('toast-host').appendChild(div);
  setTimeout(() => div.remove(), 3600);
}

const NAV = [
  { key: 'map', icon: '▦', label: '防火分区图' },
  { key: 'routes', icon: '➤', label: '路线巡检' },
  { key: 'components', icon: '⚙', label: '部件检查' },
  { key: 'faults', icon: '⚠', label: '故障列表' },
  { key: 'repair', icon: '🔧', label: '维修进度' },
  { key: 'reset', icon: '↻', label: '复位测试' },
  { key: 'overdue', icon: '⏱', label: '逾期统计' },
];

/* ============ 框架 ============ */

function renderNav(counts = {}) {
  document.getElementById('sidenav').innerHTML = NAV.map(n => `
    <div class="nav-item ${state.view === n.key ? 'active' : ''}" data-view="${n.key}">
      <span class="nav-icon">${n.icon}</span>${n.label}
      ${counts[n.key] ? `<span class="nav-count">${counts[n.key]}</span>` : ''}
    </div>`).join('');
  document.querySelectorAll('.nav-item').forEach(el =>
    el.onclick = () => { state.view = el.dataset.view; render(); });
}

async function render() {
  renderNav(await navCounts());
  const view = VIEWS[state.view] || VIEWS.map;
  document.getElementById('content').innerHTML = await view();
  if (view.after) view.after();
}

async function navCounts() {
  try {
    const [faults, stats] = await Promise.all([
      api('/api/faults?status=open'), api('/api/overdue')]);
    return {
      faults: faults.length || '',
      repair: (await api('/api/orders')).filter(o =>
        ['open', 'in_progress', 'awaiting_reset'].includes(o.status)).length || '',
      reset: (await api('/api/orders')).filter(o => o.status === 'awaiting_reset').length || '',
      overdue: (stats.counts.inspection_overdue + stats.counts.repair_overdue +
                stats.counts.measures_expired) || '',
    };
  } catch { return {}; }
}

function statusTag(s) {
  const cls = { normal: 'green', pending_repair: 'red', temp_controlled: 'amber', decommissioned: 'gray' }[s];
  return `<span class="tag ${cls}"><span class="dot" style="background:currentColor"></span>${STATUS_LABELS[s]}</span>`;
}

/* ============ 1. 防火分区图 ============ */

VIEWS.map = async () => {
  const zones = state.meta.zones;
  if (!state.selectedZone) state.selectedZone = zones[0].id;
  const zid = state.selectedZone;
  const map = await api(`/api/map?zone_id=${zid}`);
  const zone = map.zone;
  const poly = zone.polygon;
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  const left = Math.min(...xs), top = Math.min(...ys), w = Math.max(...xs) - left, h = Math.max(...ys) - top;
  const ticks = map.doors.map(d => `
    <div class="door-tick s-${d.status}" style="left:${d.map_x}%;top:${d.map_y}%;transform:translate(-50%,-50%) rotate(${d.map_angle}deg)"
         data-door="${d.id}" title="${esc(d.code)} ${esc(d.location)}">
      <span class="tick-line"></span>
      <span class="tick-code" style="transform:translateX(-50%) rotate(${-d.map_angle}deg)">${esc(d.code)}</span>
    </div>`).join('');
  return `
  <div class="page-head"><div><h2>防火分区图</h2>
    <div class="desc">门体短线与编号标记；颜色表示门体实时状态，点击短线查看门体详情与临时措施。</div></div></div>
  <div class="map-toolbar">
    <select id="zone-select">
      ${zones.map(z => `<option value="${z.id}" ${z.id === zid ? 'selected' : ''}>
        ${esc(z.building_name)} · ${esc(z.name)}</option>`).join('')}
    </select>
    <span class="muted small">${esc(zone.code)} · ${esc(zone.floor)} 层</span>
  </div>
  <div class="zone-map">
    <div class="zone-poly" style="left:${left}%;top:${top}%;width:${w}%;height:${h}%"></div>
    <div class="zone-label" style="left:${left + 1.5}%;top:${top + 1.5}%">${esc(zone.code)}</div>
    ${ticks}
  </div>
  <div class="legend">
    <span><i style="background:#2f7d4f"></i>正常</span>
    <span><i style="background:#c0392b"></i>待维修</span>
    <span><i style="background:#b9791f"></i>临时封控</span>
    <span><i style="background:#8a8f95"></i>停用</span>
    <span class="muted">虚线框＝防火分区边界，网格 2D 平面示意</span>
  </div>`;
};
VIEWS.map.after = () => {
  document.getElementById('zone-select').onchange = e => { state.selectedZone = Number(e.target.value); render(); };
  document.querySelectorAll('.door-tick').forEach(el => el.onclick = () => openDoor(Number(el.dataset.door)));
};

/* ============ 2. 路线巡检 ============ */

VIEWS.routes = async () => {
  const tasks = await api('/api/tasks');
  const rows = tasks.map(t => {
    const pct = Math.round(t.door_done / t.door_total * 100);
    const over = t.status !== 'done' && t.due_at < new Date().toISOString();
    return `<tr class="clickable" data-task="${t.id}">
      <td class="mono">${esc(t.code)}</td>
      <td>${esc(t.route_name)}</td>
      <td>${esc(t.assignee_name)}</td>
      <td>${fmtDt(t.due_at)} ${over ? '<span class="tag red">逾期</span>' : ''}</td>
      <td style="min-width:150px">
        <div class="progress-bar ${t.status === 'done' ? 'done' : ''}"><i style="width:${pct}%"></i></div>
        <div class="small muted">${t.door_done}/${t.door_total} 扇已检</div>
      </td>
      <td><span class="tag ${t.status === 'done' ? 'green' : t.status === 'in_progress' ? 'amber' : 'gray'}">${TASK_STATUS[t.status]}</span></td>
      <td class="pill-actions" onclick="event.stopPropagation()">
        ${t.status === 'pending' ? `<button class="small-btn" data-act="start" data-id="${t.id}">开始巡检</button>` : ''}
        ${t.status === 'in_progress' ? `<button class="small-btn" data-act="inspect" data-id="${t.id}">继续巡检</button>
          <button class="small-btn ghost" data-act="finish" data-id="${t.id}">完成路线</button>` : ''}
        ${t.status === 'done' ? `<button class="small-btn ghost" data-act="view" data-id="${t.id}">查看</button>` : ''}
      </td></tr>`;
  }).join('');
  return `<div class="page-head"><div><h2>路线巡检</h2>
    <div class="desc">按预定路线逐扇检查门扇、门框、闭门速度、顺序关闭与释放联动；全部门检查完才能结束路线。</div></div></div>
  <div class="card"><table><thead><tr><th>任务号</th><th>路线</th><th>巡检员</th><th>截止</th><th>进度</th><th>状态</th><th>操作</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7" class="muted">暂无巡检任务（调度器每 30 秒生成当日任务）</td></tr>'}</tbody></table></div>`;
};
VIEWS.routes.after = () => {
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.id);
    try {
      if (b.dataset.act === 'start') { await api('/api/tasks/start', { user_id: state.meId, task_id: id }); toast('巡检已开始', 'ok'); render(); }
      else if (b.dataset.act === 'finish') { await api('/api/tasks/finish', { user_id: state.meId, task_id: id }); toast('路线已完成，步骤齐全', 'ok'); render(); }
      else { const t = (await api('/api/tasks')).find(x => x.id === id); openTaskInspect(t); }
    } catch (e) { toast(e.message, 'err'); }
  });
  document.querySelectorAll('tr.clickable[data-task]').forEach(tr => tr.onclick = () =>
    openTaskInspectLite(Number(tr.dataset.task)));
};

async function openTaskInspectLite(taskId) {
  const t = (await api('/api/tasks')).find(x => x.id === taskId);
  if (t) openTaskInspect(t);
}

async function openTaskInspect(task) {
  const route = state.meta.routes.find(r => r.id === task.route_id);
  const order = route.door_order;
  const items = order.map((did, i) => {
    const d = doorById(did);
    return `<tr>
      <td class="muted">${i + 1}</td>
      <td class="mono">${esc(d.code)} ${statusTag(d.status)}</td>
      <td>${esc(d.location)}</td>
      <td>${DOOR_TYPE[d.door_type]} · ${d.leaf_count === 2 ? '双扇' : '单扇'}${d.door_type === 'normally_open' ? ' · 电磁释放' : ''}</td>
      <td>${task.status === 'in_progress'
        ? `<button class="small-btn" data-door="${did}">${d.status === 'normal' ? '检查' : '复检/登记'}</button>`
        : '<span class="muted">任务未在执行</span>'}
        <button class="small-btn ghost" data-detail="${did}">详情</button></td></tr>`;
  }).join('');
  showModal(`路线巡检 · ${esc(task.code)} — ${esc(route.name)}`, `
    <div class="small muted" style="margin-bottom:10px">
      负责人 ${esc(task.assignee_name)}；进度 ${task.door_done}/${task.door_total}；截止 ${fmtDt(task.due_at)}</div>
    <table><thead><tr><th>#</th><th>门体</th><th>位置</th><th>型式</th><th>操作</th></tr></thead><tbody>${items}</tbody></table>
  `, [{ label: '关闭', cls: 'ghost', fn: closeModal }], { wide: true });
  modalEl().querySelectorAll('[data-detail]').forEach(b => b.onclick = () => openDoor(Number(b.dataset.detail)));
  modalEl().querySelectorAll('[data-door]').forEach(b => b.onclick = () =>
    openInspectionForm(Number(b.dataset.door), task.id, () => openTaskInspect(task)));
}

/* 巡检/部件检查表单项 */
async function openInspectionForm(doorId, taskId, onDone) {
  const d = doorById(doorId);
  const detail = await api(`/api/door?id=${doorId}`);
  const comps = detail.components.map(c => `
    <div class="small" style="margin-bottom:3px">${COMP_LABELS[c.kind]}${c.leaf_label ? '（' + esc(c.leaf_label) + '）' : ''}
      <span class="muted mono">${esc(c.model || '')} ${esc(c.serial || '')}</span></div>`).join('');
  showModal(`部件检查 · ${esc(d.code)}`, `
    <div class="kv" style="margin-bottom:10px">
      <dt>位置/型式</dt><dd>${esc(d.location)} · ${DOOR_TYPE[d.door_type]} · ${d.leaf_count === 2 ? '双扇带顺序器' : '单扇'}</dd>
      <dt>部件</dt><dd>${comps}</dd></div>
    <div class="checklist" id="insp-flags">
      <label><input type="checkbox" id="f-accessible" checked> 现场可进入</label>
      <label><input type="checkbox" id="f-wedged"> 发现门体被楔开</label>
      <label><input type="checkbox" id="f-fan" checked> 门扇完好</label>
      <label><input type="checkbox" id="f-frame" checked> 门框完好</label>
    </div>
    <div class="row-inline" style="margin:8px 0">
      <label class="small">90°→全关用时(秒，合格区间 3~10)
        <input type="number" id="f-seconds" step="0.1" min="0.5" value="6.0" style="width:110px"></label>
      ${d.leaf_count === 2 ? '<label class="small">双扇顺序关闭正确<input type="checkbox" id="f-seq" checked></label>' : ''}
      ${d.door_type === 'normally_open' ? '<label class="small">电磁释放联动/回传正常<input type="checkbox" id="f-link" checked> ' +
        '<button class="small-btn ghost" id="btn-release">模拟释放测试</button></label>' : ''}
    </div>
    <label class="field">检查备注<textarea id="f-note" rows="2" placeholder="异常现象、位置、处置建议"></textarea></label>
    <div id="release-result" class="small"></div>
  `, [
    { label: '取消', cls: 'ghost', fn: closeModal },
    { label: '提交检查', cls: 'red', fn: async () => {
      try {
        const accessible = document.getElementById('f-accessible').checked;
        const payload = {
          user_id: state.meId, task_id: taskId, door_id: doorId,
          accessible,
          wedged: document.getElementById('f-wedged').checked,
          fan_ok: document.getElementById('f-fan').checked,
          frame_ok: document.getElementById('f-frame').checked,
          close_seconds: accessible ? Number(document.getElementById('f-seconds').value) : null,
          sequence_ok: d.leaf_count === 2 ? document.getElementById('f-seq').checked : null,
          linkage_ok: d.door_type === 'normally_open' ? document.getElementById('f-link').checked : null,
          note: document.getElementById('f-note').value,
        };
        const res = await api('/api/inspections', payload);
        closeModal();
        toast(res.result === 'pass' ? '检查合格，已留痕' :
          `已登记故障 ${res.faults.length} 项，门体转入待维修`, res.result === 'pass' ? 'ok' : 'err');
        onDone && onDone(); render();
      } catch (e) { toast(e.message, 'err'); }
    } },
  ], { wide: true });
  const flags = modalEl().querySelector('#insp-flags');
  flags.querySelectorAll('input').forEach(cb => cb.onchange = () => {
    cb.checked ? cb.parentElement.classList.remove('bad') : cb.parentElement.classList.add('bad');
  });
  const relBtn = document.getElementById('btn-release');
  if (relBtn) relBtn.onclick = async () => {
    try {
      const r = await api(`/api/doors/${doorId}/release`, { user_id: state.meId });
      document.getElementById('release-result').innerHTML = r.ok
        ? `<span class="tag green">释放成功，${r.response_ms}ms 收到回传</span>`
        : `<span class="tag red">联动失败：NO_FEEDBACK，信号无回传</span>`;
      const link = document.getElementById('f-link'); if (link) link.checked = r.ok;
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ============ 3. 部件检查（门/部件总览） ============ */

VIEWS.components = async () => {
  const rows = state.meta.doors.map(d => {
    const z = zoneById(d.zone_id);
    return `<tr class="clickable" data-door="${d.id}">
      <td class="mono">${esc(d.code)}</td>
      <td>${esc(z.building_name)}<div class="small muted">${esc(z.code)} · ${esc(d.location)}</div></td>
      <td>${DOOR_TYPE[d.door_type]} / ${d.leaf_count === 2 ? '双扇' : '单扇'}</td>
      <td>${d.has_em_release ? '<span class="tag graphite">电磁释放</span>' : ''}</td>
      <td>${statusTag(d.status)}</td>
      <td class="pill-actions" onclick="event.stopPropagation()">
        <button class="small-btn ghost" data-detail="${d.id}">详情</button></td></tr>`;
  }).join('');
  return `<div class="page-head"><div><h2>部件检查</h2>
    <div class="desc">全部门体与闭门器/顺序器/电磁释放台账；在“路线巡检”中执行逐项检查，详情页可看部件、照片与留痕。</div></div></div>
  <div class="card"><table><thead><tr><th>门体编号</th><th>楼栋/位置</th><th>型式</th><th>装置</th><th>状态</th><th>操作</th></tr></thead>
  <tbody>${rows}</tbody></table></div>`;
};
VIEWS.components.after = bindDoorRows;

function bindDoorRows() {
  document.querySelectorAll('tr.clickable[data-door], [data-detail]').forEach(el =>
    el.onclick = () => openDoor(Number(el.dataset.door || el.dataset.detail)));
}

/* ============ 4. 故障列表 ============ */

VIEWS.faults = async () => {
  const faults = await api('/api/faults');
  const rows = faults.map(f => {
    const stCls = { open: 'red', in_repair: 'amber', resolved: 'gray', closed: 'green' }[f.status];
    const stTxt = { open: '待派单', in_repair: '维修中', resolved: '待复位', closed: '已关闭' }[f.status];
    return `<tr class="clickable" data-door="${f.door_id}">
      <td class="mono">${esc(f.code)}</td>
      <td class="mono">${esc(f.door_code)} <div class="small muted">${esc(f.zone_code)}</div></td>
      <td><span class="tag ${f.fault_type === 'reset_failed' ? 'graphite' : 'red'}">${faultText(f.fault_type)}</span></td>
      <td>${esc(f.found_by_name)}<div class="small muted">${fmtDt(f.found_at)}</div></td>
      <td><span class="tag ${stCls}">${stTxt}</span></td>
      <td class="pill-actions" onclick="event.stopPropagation()">
        ${f.status === 'open' ? `<button class="small-btn red" data-dispatch="${f.id}">派维修单</button>` : ''}
        ${f.status === 'in_repair' && !f.order_status ? `<button class="small-btn" data-dispatch="${f.id}">派维修单</button>` : ''}
        <button class="small-btn ghost" data-detail="${f.door_id}">门详情</button></td></tr>`;
  }).join('');
  return `<div class="page-head"><div><h2>故障列表</h2>
    <div class="desc">楔开、闭门过快、顺序错误、信号无回传、无法进入、维修超时、复位失败全部独立留痕；同一故障不重复关闭。</div></div></div>
  <div class="card"><table><thead><tr><th>故障号</th><th>门体</th><th>类型</th><th>发现人/时间</th><th>状态</th><th>操作</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" class="muted">无故障记录</td></tr>'}</tbody></table></div>`;
};
VIEWS.faults.after = () => {
  bindDoorRows();
  document.querySelectorAll('[data-dispatch]').forEach(b => b.onclick = () => dispatchOrder(Number(b.dataset.dispatch)));
};

async function dispatchOrder(faultId) {
  if (!me()) return toast('请先选择操作人', 'err');
  const repairers = state.meta.users.filter(u => u.role === 'repairer');
  showModal('派维修单', `
    <div class="small muted" style="margin-bottom:10px">同一门体同一时刻仅允许一张活动维修单占用。</div>
    <label class="field">维修人<select id="m-rep">${repairers.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
    <label class="field">SLA（小时）<input type="number" id="m-sla" value="24" min="1" max="168"></label>
  `, [
    { label: '取消', cls: 'ghost', fn: closeModal },
    { label: '确认派单', cls: 'red', fn: async () => {
      try {
        const r = await api('/api/orders', { user_id: Number(document.getElementById('m-rep').value),
          fault_id: faultId, sla_hours: Number(document.getElementById('m-sla').value) });
        closeModal(); toast(`维修单 #${r.order_id} 已创建，门体被占用`, 'ok'); render();
      } catch (e) { toast(e.message, 'err'); }
    } },
  ]);
}

/* ============ 5. 维修进度 ============ */

VIEWS.repair = async () => {
  const orders = await api('/api/orders');
  const cards = orders.map(o => {
    const done = o.steps.filter(s => s.done).length;
    const pct = Math.round(done / o.steps.length * 100);
    const over = ['open', 'in_progress', 'awaiting_reset'].includes(o.status) && o.due_at < new Date().toISOString();
    const steps = o.steps.map(s => `
      <li class="${s.done ? 'done' : ''}">
        <span class="step-box">✓</span>
        <div style="flex:1">${esc(s.label)}
          ${s.done ? `<div class="step-meta">${esc(s.done_by_name || '')} ${fmtDt(s.done_at)}</div>` : ''}</div>
        ${!s.done && ['open', 'in_progress'].includes(o.status)
          ? `<button class="small-btn" data-step="${s.step_key}" data-oid="${o.id}">登记</button>` : ''}
      </li>`).join('');
    return `<div class="card">
      <div class="row-inline" style="justify-content:space-between">
        <h3><span class="mono">${esc(o.code)}</span> ${esc(o.door_code)}
          <span class="tag ${o.status === 'awaiting_reset' ? 'amber' : o.status === 'done' ? 'green' : 'red'}">${ORDER_STATUS[o.status]}</span>
          ${over ? '<span class="tag red">已超时</span>' : ''}
        </h3>
        <div class="small muted">故障 ${esc(o.fault_code)} · 维修 ${esc(o.repairer_name)} · SLA ${fmtDt(o.due_at)}</div>
      </div>
      <div class="row-inline" style="margin:8px 0">
        <div class="progress-bar ${o.status === 'done' ? 'done' : ''}" style="flex:1"><i style="width:${pct}%"></i></div>
        <span class="small muted">${done}/${o.steps.length} 步</span>
        ${['open', 'in_progress'].includes(o.status)
          ? `<button class="small-btn red" data-complete="${o.id}">维修完成（提交复位）</button>` : ''}
        <button class="small-btn ghost" data-detail="${o.door_id}">门详情</button>
      </div>
      <ul class="steps">${steps}</ul>
    </div>`;
  }).join('');
  return `<div class="page-head"><div><h2>维修进度</h2>
    <div class="desc">六项必做步骤全部完成才能提交复位；复位必须由维修人以外的另一人执行。</div></div></div>${cards || '<div class="card muted">暂无维修单</div>'}`;
};
VIEWS.repair.after = () => {
  bindDoorRows();
  document.querySelectorAll('[data-step]').forEach(b => b.onclick = async () => {
    try {
      await api(`/api/orders/${b.dataset.oid}/step`, { user_id: state.meId, step_key: b.dataset.step });
      toast('步骤已登记', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-complete]').forEach(b => b.onclick = async () => {
    try {
      await api(`/api/orders/${b.dataset.complete}/complete`, { user_id: state.meId, note: '全部步骤完成' });
      toast('维修完成，已进入待复位（需他人测试）', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
};

/* ============ 6. 复位测试 ============ */

VIEWS.reset = async () => {
  const orders = (await api('/api/orders')).filter(o => o.status === 'awaiting_reset');
  const resets = await api('/api/resets');
  const pending = orders.map(o => `
    <tr><td class="mono">${esc(o.code)}</td><td class="mono">${esc(o.door_code)}</td>
    <td>${esc(o.repairer_name)} <span class="muted small">（本人不可测试）</span></td>
    <td>${fmtDt(o.completed_at)}</td>
    <td><button class="small-btn red" data-reset="${o.id}" data-door="${o.door_id}" data-rep="${o.repairer_id}">执行复位测试</button></td></tr>`).join('');
  const history = resets.map(r => `
    <tr class="clickable" data-rid="${r.id}">
      <td class="mono">${esc(r.code)}</td><td class="mono">${esc(r.door_code)}</td>
      <td>${esc(r.tester_name)}</td><td>${fmtDt(r.created_at)}</td>
      <td>${r.result === 'pass'
        ? '<span class="tag green">全部合格·恢复正常</span>'
        : `<span class="tag red">不合格·退回维修</span><div class="small muted">${esc((r.fail_reasons || []).join('；'))}</div>`}</td>
      <td><button class="small-btn ghost" data-trace="${r.id}">闭门轨迹</button></td></tr>`).join('');
  return `<div class="page-head"><div><h2>复位测试</h2>
    <div class="desc">门扇、门框、闭门速度、双扇顺序、释放联动、封堵全部测试项合格方可恢复正常；测试人须与维修人不同。</div></div></div>
  <div class="card"><h3>待复位工单</h3><table><thead><tr><th>维修单</th><th>门体</th><th>维修人</th><th>完工时间</th><th>操作</th></tr></thead>
  <tbody>${pending || '<tr><td colspan="5" class="muted">暂无待复位工单</td></tr>'}</tbody></table></div>
  <div class="card"><h3>复位记录</h3><table><thead><tr><th>测试号</th><th>门体</th><th>测试人</th><th>时间</th><th>结果</th><th>轨迹</th></tr></thead>
  <tbody>${history || '<tr><td colspan="6" class="muted">暂无复位记录</td></tr>'}</tbody></table></div>`;
};
VIEWS.reset.after = () => {
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () =>
    openResetForm(Number(b.dataset.reset), Number(b.dataset.door), Number(b.dataset.rep)));
  document.querySelectorAll('tr[data-rid]').forEach(el => el.onclick = () => openTrace(Number(el.dataset.rid)));
  document.querySelectorAll('[data-trace]').forEach(el => el.onclick = e => {
    e.stopPropagation();
    openTrace(Number(el.dataset.trace));
  });
};

async function openResetForm(orderId, doorId, repairerId) {
  const d = doorById(doorId);
  const u = me();
  if (!u) return toast('请先选择操作人', 'err');
  if (u.id === repairerId) return toast('职责分离：维修人不能测试自己的维修，请切换另一人', 'err');
  showModal(`复位测试 · ${esc(d.code)}`, `
    <div class="small muted" style="margin-bottom:10px">测试人 <b>${esc(u.name)}</b>（${ROLE_LABELS[u.role]}）；
      维修人 <b>${state.meta.users.find(x => x.id === repairerId)?.name}</b>。任一必测项不合格即退回维修。</div>
    <div class="checklist" id="rt-flags">
      <label><input type="checkbox" id="r-fan" checked> 门扇合格</label>
      <label><input type="checkbox" id="r-frame" checked> 门框合格</label>
      <label><input type="checkbox" id="r-seal" checked> 防火封堵合格</label>
      ${d.leaf_count === 2 ? '<label><input type="checkbox" id="r-seq" checked> 双扇顺序正确（从动扇先关严）</label>' : ''}
      ${d.door_type === 'normally_open' ? '<label><input type="checkbox" id="r-link" checked> 释放联动与信号回传正常</label>' : ''}
    </div>
    <div class="row-inline" style="margin:8px 0">
      <label class="small">主动扇关闭用时(秒)<input type="number" id="r-s1" step="0.1" value="5.5" style="width:100px"></label>
      ${d.leaf_count === 2 ? '<label class="small">从动扇关闭用时(秒)<input type="number" id="r-s2" step="0.1" value="4.6" style="width:100px"></label>' : ''}
      <span class="tag green">合格区间 3.0~10.0 秒</span>
    </div>
    <label class="field">备注<textarea id="r-note" rows="2"></textarea></label>
  `, [
    { label: '取消', cls: 'ghost', fn: closeModal },
    { label: '提交复位测试', cls: 'red', fn: async () => {
      try {
        const payload = {
          user_id: u.id, order_id: orderId,
          fan_ok: document.getElementById('r-fan').checked,
          frame_ok: document.getElementById('r-frame').checked,
          seal_ok: document.getElementById('r-seal').checked,
          close_seconds: Number(document.getElementById('r-s1').value),
          close_seconds_secondary: d.leaf_count === 2 ? Number(document.getElementById('r-s2').value) : null,
          sequence_ok: d.leaf_count === 2 ? document.getElementById('r-seq').checked : null,
          linkage_ok: d.door_type === 'normally_open' ? document.getElementById('r-link').checked : null,
          note: document.getElementById('r-note').value,
        };
        const res = await api('/api/resets', payload);
        closeModal();
        if (res.result === 'pass') toast(`复位 ${res.code} 全部合格，门体恢复正常`, 'ok');
        else toast(`复位 ${res.code} 不合格，已退回维修：${res.fail_reasons.join('；')}`, 'err');
        render();
      } catch (e) { toast(e.message, 'err'); }
    } },
  ], { wide: true });
  modalEl().querySelectorAll('#rt-flags input').forEach(cb => cb.onchange = () =>
    cb.parentElement.classList.toggle('bad', !cb.checked));
}

/* 闭门时间刻度轨迹图 */
function traceSVG(samples, color) {
  const W = 460, H = 160, padL = 38, padB = 26, padT = 12, padR = 12;
  const tMax = Math.max(...samples.map(s => s[0]), 1);
  const x = t => padL + (W - padL - padR) * (t / tMax);
  const y = a => padT + (H - padT - padB) * (1 - a / 90);
  const path = samples.map((s, i) => `${i ? 'L' : 'M'}${x(s[0]).toFixed(1)},${y(s[1]).toFixed(1)}`).join(' ');
  const tTicks = [0, .25, .5, .75, 1].map(f => {
    const tv = tMax * f, xx = x(tv);
    return `<line x1="${xx}" y1="${padT}" x2="${xx}" y2="${H - padB}" stroke="#e3ddd2"/>
      <text x="${xx}" y="${H - 9}" font-size="9" fill="#8a8f95" text-anchor="middle">${tv.toFixed(1)}s</text>`;
  }).join('');
  const aTicks = [90, 60, 30, 0].map(a => `<line x1="${padL}" y1="${y(a)}" x2="${W - padR}" y2="${y(a)}" stroke="#eee8dd"/>
    <text x="${padL - 5}" y="${y(a) + 3}" font-size="9" fill="#8a8f95" text-anchor="end">${a}°</text>`).join('');
  const total = samples.length ? samples[samples.length - 1][0] : 0;
  // 合格区间阴影（角度图上不易表达，用底部时间条标记 3~10s 区间）
  const x3 = x(Math.min(3, tMax)), x10 = x(Math.min(10, tMax));
  const band = tMax >= 3 ? `<rect x="${x3}" y="${H - padB - 4}" width="${Math.max(0, x10 - x3)}" height="4" fill="#2f7d4f" opacity=".55"/>` : '';
  return `<svg class="trace-svg" viewBox="0 0 ${W} ${H}">
    ${aTicks}${tTicks}
    <rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" fill="none" stroke="#d8d2c7"/>
    ${band}
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.4"/>
    ${samples.map(s => `<circle cx="${x(s[0])}" cy="${y(s[1])}" r="2.6" fill="${color}"/>`).join('')}
    <text x="${W - padR}" y="${padT + 8}" font-size="10" text-anchor="end" fill="${color}">全关用时 ${total.toFixed(1)}s</text>
  </svg>`;
}

async function openTrace(resetId) {
  const d = await api(`/api/resets?id=${resetId}`);
  const r = d.reset;
  const pass = r.result === 'pass';
  const panels = d.traces.map(t => `
    <div class="trace-panel">
      <h4><span>${esc(t.leaf_label)}关闭轨迹</span>
        <span class="${pass ? 'trace-pass' : 'trace-fail'}">${pass ? '✓ 合格' : '✗ ' + esc((r.fail_reasons || []).join('；'))}</span></h4>
      ${traceSVG(t.samples, pass ? '#2f7d4f' : '#c0392b')}
    </div>`).join('');
  showModal(`复位 ${esc(r.code)} · ${esc(r.door_code)}`, `
    <div class="small muted" style="margin-bottom:8px">测试人 ${esc(r.tester_name)} · ${fmtDt(r.created_at)} · 工单 ${esc(r.order_code)}</div>
    <div class="${d.traces.length > 1 ? 'dual-wrap' : ''}">${panels}</div>
    <div class="small muted" style="margin-top:8px">横轴为时间刻度（秒），纵轴为门扇开启角度 90°→0°；绿条为合格闭门时间 3~10 秒。
      双扇并列展示，顺序正确时从动扇应先于主动扇关严。</div>
  `, [{ label: '关闭', cls: 'ghost', fn: closeModal }], { wide: true });
}

/* ============ 7. 逾期统计 ============ */

VIEWS.overdue = async () => {
  const s = await api('/api/overdue');
  const c = s.counts;
  const typeRows = Object.entries(s.open_faults_by_type).map(([t, n]) =>
    `<tr><td>${faultText(t)}</td><td><b>${n}</b></td></tr>`).join('');
  const insRows = s.inspection_overdue.map(t => `<tr>
    <td class="mono">${esc(t.code)}</td><td>${esc(t.route_name)}</td><td>${esc(t.assignee_name)}</td>
    <td>${fmtDt(t.due_at)}</td><td><span class="tag amber">${TASK_STATUS[t.status]}</span></td></tr>`).join('');
  const repRows = s.repair_overdue.map(o => `<tr>
    <td class="mono">${esc(o.code)}</td><td class="mono">${esc(o.door_code)}</td><td>${esc(o.repairer_name)}</td>
    <td>${fmtDt(o.due_at)}</td><td><span class="tag red">${ORDER_STATUS[o.status]}</span></td></tr>`).join('');
  const measRows = s.measures_expired.map(m => {
    const d = doorById(m.door_id);
    return `<tr><td class="mono">${esc(d?.code || m.door_id)}</td><td>${esc(m.reason)}</td>
      <td>${fmtDt(m.starts_at)} → ${fmtDt(m.expires_at)}</td>
      <td><span class="tag ${m.status === 'expired' ? 'red' : 'amber'}">${m.status === 'expired' ? '已过期' : '生效中但已到期'}</span></td></tr>`;
  }).join('');
  return `<div class="page-head"><div><h2>逾期统计</h2>
    <div class="desc">进程内调度每 30 秒扫描：巡检到期、维修 SLA 超时、临时措施到期；维修超时自动登记故障并留痕。</div></div></div>
  <div class="grid grid-4">
    <div class="stat ${c.inspection_overdue ? 'alert' : 'ok'}"><div class="num">${c.inspection_overdue}</div><div class="lbl">巡检逾期</div></div>
    <div class="stat ${c.repair_overdue ? 'alert' : 'ok'}"><div class="num">${c.repair_overdue}</div><div class="lbl">维修超时</div></div>
    <div class="stat ${c.measures_expired ? 'warn' : 'ok'}"><div class="num">${c.measures_expired}</div><div class="lbl">临时措施到期</div></div>
    <div class="stat ${c.active_measures ? 'warn' : 'ok'}"><div class="num">${c.active_measures}</div><div class="lbl">生效中临时措施</div></div>
  </div>
  <div class="grid grid-2" style="margin-top:14px">
    <div class="card"><h3>逾期巡检任务</h3><table><thead><tr><th>任务</th><th>路线</th><th>人</th><th>截止</th><th>状态</th></tr></thead>
      <tbody>${insRows || '<tr><td colspan="5" class="muted">无</td></tr>'}</tbody></table></div>
    <div class="card"><h3>维修超时工单</h3><table><thead><tr><th>工单</th><th>门</th><th>维修人</th><th>SLA</th><th>状态</th></tr></thead>
      <tbody>${repRows || '<tr><td colspan="5" class="muted">无</td></tr>'}</tbody></table></div>
  </div>
  <div class="grid grid-2">
    <div class="card"><h3>到期/过期临时措施</h3><table><thead><tr><th>门</th><th>原因</th><th>期限</th><th>状态</th></tr></thead>
      <tbody>${measRows || '<tr><td colspan="4" class="muted">无</td></tr>'}</tbody></table></div>
    <div class="card"><h3>未关闭故障分类</h3><table><thead><tr><th>类型</th><th>数量</th></tr></thead>
      <tbody>${typeRows || '<tr><td colspan="2" class="muted">无</td></tr>'}</tbody></table></div>
  </div>`;
};

/* ============ 门体详情（顶部持续可见临时措施） ============ */

async function openDoor(doorId) {
  const d = await api(`/api/door?id=${doorId}`);
  const door = d.door, z = d.zone;
  const u = me();
  const activeM = d.measures.find(m => m.status === 'active');
  const expiredM = d.measures.find(m => m.status === 'expired');
  let banner = '';
  if (door.status === 'decommissioned') {
    banner = `<div class="decom-banner"><b>⛔ 门体已停用</b><div class="small">${esc(door.decommission_reason || '')}</div></div>`;
  } else if (activeM) {
    banner = `<div class="measure-banner">
      <span class="mb-icon">⚠</span>
      <div class="mb-body"><b>临时措施持续生效中</b>：${esc(activeM.reason)}
        <div class="mb-meta">批准人 ${esc(activeM.approver_name)} · ${fmtDt(activeM.starts_at)} 起 ·
          <b>${fmtDt(activeM.expires_at)} 到期</b></div></div>
      ${u && ['supervisor', 'manager'].includes(u.role) ? `<button class="small-btn" id="btn-release-m">提前解除</button>` : ''}
    </div>`;
  } else if (expiredM) {
    banner = `<div class="measure-banner expired">
      <span class="mb-icon">⛔</span>
      <div class="mb-body"><b>临时措施已到期失效</b>：${esc(expiredM.reason)}
        <div class="mb-meta">已于 ${fmtDt(expiredM.expires_at)} 到期，门体回到待维修管控，须续批或完成修复复位</div></div>
      ${u && ['supervisor', 'manager'].includes(u.role) ? `<button class="small-btn red" id="btn-measure">续批临时措施</button>` : ''}
    </div>`;
  }
  const comps = d.components.map(c => `<tr>
    <td>${COMP_LABELS[c.kind]}</td><td>${esc(c.leaf_label || '—')}</td>
    <td class="mono">${esc(c.model || '')}</td><td class="mono">${esc(c.serial || '')}</td>
    <td><span class="tag ${c.status === 'ok' ? 'green' : 'red'}">${c.status === 'ok' ? '正常' : '故障'}</span></td></tr>`).join('');
  const faultRows = d.faults.map(f => `<tr>
    <td class="mono">${esc(f.code)}</td><td>${faultText(f.fault_type)}</td>
    <td>${esc(f.found_by_name)}</td><td>${fmtDt(f.found_at)}</td>
    <td><span class="tag ${f.status === 'closed' ? 'green' : f.status === 'resolved' ? 'gray' : 'red'}">${f.status}</span></td></tr>`).join('');
  const orderRows = d.orders.map(o => `<tr>
    <td class="mono">${esc(o.code)}</td><td>${esc(o.repairer_name)}</td>
    <td>${fmtDt(o.created_at)}</td><td><span class="tag ${o.status === 'done' ? 'green' : 'amber'}">${ORDER_STATUS[o.status]}</span></td></tr>`).join('');
  const photos = d.photos.map(p => `<img class="photo-thumb" src="/photos/?p=${encodeURIComponent(p.photo_path)}" alt="门体照片">`).join('') || '<span class="muted small">暂无照片（演示库含 FM-101 占位照片）</span>';
  const timeline = d.events.map(e => `<li class="cat-${esc(e.category)}">
    <span class="ts">${fmtDt(e.ts)}</span>${esc(e.actor_name || '系统')}：${esc(e.summary)}</li>`).join('');
  const actions = [];
  if (u && u.role === 'inspector' && door.status !== 'decommissioned')
    actions.push(`<button class="small-btn" id="btn-inspect">巡检登记（需在任务中）</button>`);
  const openFault = d.faults.find(f => f.status === 'open');
  if (u && u.role === 'repairer' && openFault)
    actions.push(`<button class="small-btn red" id="btn-dispatch">派维修单</button>`);
  if (u && door.door_type === 'normally_open' && door.status !== 'decommissioned')
    actions.push(`<button class="small-btn ghost" id="btn-release2">电磁释放测试</button>`);
  if (u && ['supervisor', 'manager'].includes(u.role)) {
    if (!activeM && !expiredM) actions.push(`<button class="small-btn ghost" id="btn-measure">批准临时措施</button>`);
    actions.push(`<button class="small-btn ghost" id="btn-decom">${door.status === 'decommissioned' ? '解除停用' : '停用标记'}</button>`);
  }

  showModal(`门体详情 · ${esc(door.code)}`, `
    ${banner}
    <div class="row-inline" style="justify-content:space-between">
      <div class="kv" style="flex:1">
        <dt>位置</dt><dd>${esc(z.building_name)} / ${esc(z.name)} · ${esc(door.location)}</dd>
        <dt>型式</dt><dd>${DOOR_TYPE[door.door_type]} · ${door.leaf_count === 2 ? '双扇带顺序器' : '单扇'} · 封堵${door.seal_status === 'intact' ? '完好' : '有缺陷'}</dd>
        <dt>状态</dt><dd>${statusTag(door.status)}</dd>
      </div>
      <div class="pill-actions" style="text-align:right">${actions.join('')}</div>
    </div>
    <div class="section-title">部件</div>
    <table><thead><tr><th>部件</th><th>扇位</th><th>型号</th><th>序列号</th><th>状态</th></tr></thead><tbody>${comps}</tbody></table>
    <div class="grid grid-2" style="margin-top:6px">
      <div><div class="section-title">故障历史</div>
        <table><thead><tr><th>单号</th><th>类型</th><th>发现人</th><th>时间</th><th>状态</th></tr></thead>
        <tbody>${faultRows || '<tr><td colspan="5" class="muted">无</td></tr>'}</tbody></table></div>
      <div><div class="section-title">维修单</div>
        <table><thead><tr><th>单号</th><th>维修人</th><th>创建</th><th>状态</th></tr></thead>
        <tbody>${orderRows || '<tr><td colspan="4" class="muted">无</td></tr>'}</tbody></table></div>
    </div>
    <div class="section-title">门体照片（本地目录 data/photos）</div><div class="row-inline">${photos}</div>
    <div class="section-title">全程留痕</div><ul class="timeline">${timeline}</ul>
  `, [{ label: '关闭', cls: 'ghost', fn: closeModal }], { wide: true });

  const $ = id => document.getElementById(id);
  if ($('btn-release-m')) $('btn-release-m').onclick = async () => {
    try { await api(`/api/measures/${activeM.id}/release`, { user_id: u.id }); closeModal(); toast('临时措施已解除', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  };
  if ($('btn-measure')) $('btn-measure').onclick = () => { if (!$('btn-measure').textContent.trim()) return; measureForm(doorId); };
  if ($('btn-decom')) $('btn-decom').onclick = () => decommissionForm(door, u.id);
  if ($('btn-dispatch')) $('btn-dispatch').onclick = () => { closeModal(); dispatchOrder(openFault.id); };
  if ($('btn-release2')) $('btn-release2').onclick = async () => {
    try { const r = await api(`/api/doors/${doorId}/release`, { user_id: u.id });
      toast(r.ok ? `释放成功，${r.response_ms}ms 回传` : '联动失败，信号无回传（已留痕）', r.ok ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
  };
  if ($('btn-inspect')) $('btn-inspect').onclick = async () => {
    const tasks = await api('/api/tasks');
    const t = tasks.find(x => x.status === 'in_progress' &&
      state.meta.routes.find(r => r.id === x.route_id)?.door_order.includes(doorId));
    if (!t) return toast('没有包含此门且进行中的巡检任务，请先在路线巡检中开始任务', 'err');
    openInspectionForm(doorId, t.id, () => openDoor(doorId));
  };
}

function measureForm(doorId) {
  const u = me();
  showModal('批准临时措施', `
    <div class="small muted" style="margin-bottom:10px">仅安全主管/经理可批准；措施到期后自动失效，门体回到待维修管控。</div>
    <label class="field">措施与原因<textarea id="tm-reason" rows="3" placeholder="如：临时封控并安排人员值守，等待耐火材料"></textarea></label>
    <label class="field">有效时长（小时，≤168）<input type="number" id="tm-hours" value="24" min="1" max="168"></label>
  `, [
    { label: '取消', cls: 'ghost', fn: closeModal },
    { label: '批准', cls: 'red', fn: async () => {
      try {
        await api('/api/measures', { user_id: u.id, door_id: doorId,
          reason: document.getElementById('tm-reason').value, hours: Number(document.getElementById('tm-hours').value) });
        closeModal(); toast('临时措施已批准，门体进入临时封控', 'ok'); render(); openDoor(doorId);
      } catch (e) { toast(e.message, 'err'); }
    } },
  ]);
}

async function decommissionForm(door, uid) {
  const active = door.status === 'decommissioned';
  showModal(active ? '解除停用标记' : '停用门体', `
    <div class="small muted" style="margin-bottom:10px">${active ? '解除后门体将按故障/措施重新推导状态。' : '被活动维修单占用的门体不能停用。'}</div>
    ${active ? '' : '<label class="field">停用原因<textarea id="dc-reason" rows="3"></textarea></label>'}
  `, [
    { label: '取消', cls: 'ghost', fn: closeModal },
    { label: active ? '解除停用' : '确认停用', cls: 'red', fn: async () => {
      try {
        await api(`/api/doors/${door.id}/decommission`, { user_id: uid, active: !active,
          reason: active ? '' : document.getElementById('dc-reason').value });
        closeModal(); toast(active ? '停用标记已解除' : '门体已停用并留痕', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); }
    } },
  ]);
}

/* ============ Modal ============ */

function modalEl() { return document.getElementById('modal-host'); }
function showModal(title, html, buttons, opts = {}) {
  modalEl().innerHTML = `<div class="modal-mask"><div class="modal ${opts.wide ? 'wide' : ''}">
    <div class="modal-head"><h3>${title}</h3><button class="modal-close">×</button></div>
    <div class="modal-body">${html}</div>
    <div class="modal-foot"></div></div></div>`;
  const foot = modalEl().querySelector('.modal-foot');
  (buttons || [{ label: '关闭', cls: 'ghost', fn: closeModal }]).forEach(b => {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = b.cls || '';
    btn.onclick = b.fn;
    foot.appendChild(btn);
  });
  modalEl().querySelector('.modal-close').onclick = closeModal;
  modalEl().querySelector('.modal-mask').addEventListener('click', e => {
    if (e.target.classList.contains('modal-mask')) closeModal();
  });
}
function closeModal() { modalEl().innerHTML = ''; }

/* ============ 提醒轮询 / 初始化 ============ */

async function pollNotifications() {
  try {
    const r = await api('/api/notifications');
    const dot = document.getElementById('notify-dot');
    if (r.notifications.length) {
      dot.classList.add('active');
      dot.title = r.notifications.slice(-5).map(n => n.message).join('\n');
    }
  } catch { /* 忽略 */ }
}

async function boot() {
  state.meta = await api('/api/meta');
  if (!state.meta.users.some(u => u.id === state.meId)) state.meId = state.meta.users[0]?.id || 0;
  const sel = document.getElementById('user-select');
  sel.innerHTML = state.meta.users.map(u =>
    `<option value="${u.id}" ${u.id === state.meId ? 'selected' : ''}>${esc(u.name)}（${ROLE_LABELS[u.role]}）</option>`).join('');
  sel.onchange = () => { state.meId = Number(sel.value); localStorage.setItem('meId', state.meId); renderHeader(); render(); };
  renderHeader();
  await render();
  state.pollTimer = setInterval(pollNotifications, 15000);
}

function renderHeader() {
  const u = me();
  document.getElementById('role-badge').textContent = u ? ROLE_LABELS[u.role] : '';
}

// 视图对象在文件顶部创建，各 VIEWS.xxx 在上面挂载；最后启动
boot().catch(e => {
  document.getElementById('content').innerHTML =
    `<div class="card" style="color:#c0392b">初始化失败：${esc(e.message)}</div>`;
});
