import { api, DOOR_STATUS_LABEL, FAULT_STATUS_LABEL, FAULT_KIND_LABEL, EVENT_LABEL, SEAL_LABEL, RESET_ITEM_LABEL } from './api.js';
import { el, badge, fmtDT, modal, toast, wrap, requireRole } from './ui.js';
import { reportFaultModal, resetTestModal } from './app.js';

const AXIS_MAX = 5000; // 时间轴主刻度 0–5s；超过部分截断标注

// ---------- 闭门测试时间刻度 ----------
function pct(ms) {
  if (ms == null) return null;
  return Math.min(100, Math.max(0, (ms / AXIS_MAX) * 100));
}

function closeLeafColumn(test) {
  const isA = test.leaf === 'A';
  const ticks = [0, 1000, 2000, 3000, 4000, 5000];
  const closedBad = test.result === 'fail';
  const over = test.closed_ms != null && test.closed_ms > AXIS_MAX;
  const col = el('div', { class: 'leaf-col' },
    el('h4', {},
      el('span', {}, test.leaf === 'S' ? '单扇门关闭过程' : `${test.leaf} 扇关闭过程`),
      badge(test.result === 'pass' ? '合格' : '不合格', test.result === 'pass' ? 'normal' : 'reset_failed')));

  const track = el('div', { class: 'tl-track' });
  // 过快区 0–2s
  track.append(el('div', { class: 'tl-band-fast', style: 'width:40%' },
    el('span', { class: 'small muted', style: 'position:absolute;top:6px;left:6px;font-size:10px' }, '过快 <2s')));
  // 轴
  track.append(el('div', { class: 'tl-axis' }));
  for (const tk of ticks) {
    const t = el('div', { class: `tl-tick ${tk === 2000 ? 't-mid' : ''}`, style: `left:${pct(tk)}%` });
    track.append(t);
    track.append(el('div', { class: 'tl-tick-label', style: `left:${pct(tk)}%` }, tk === 0 ? '0' : `${tk / 1000}s`));
  }
  // 关闭过程条：开始动作 -> 完全关闭
  const s = pct(test.start_move_ms), c = pct(test.closed_ms);
  if (s != null && c != null) {
    track.append(el('div', {
      class: `tl-bar ${isA ? 'leaf-a' : 'leaf-b'}`,
      style: `left:${s}%;width:${Math.max(1.2, c - s)}%;bottom:17px`,
    }));
  }
  const pt = (ms, cls, label) => {
    const x = pct(ms);
    if (x == null) return null;
    const d = el('div', { class: `tl-pt ${cls}`, style: `left:${x}%`, title: `${label} ${ms}ms` });
    track.append(d);
    track.append(el('div', { class: 'tl-leaf-label', style: `left:${x}%;top:auto;bottom:30px;font-size:9.5px;color:var(--graphite-3)` }, label));
  };
  pt(test.start_move_ms, 'start', '启动');
  pt(test.latch_ms, 'latch', '锁口');
  pt(test.closed_ms, closedBad ? 'closed bad' : 'closed', over ? '>5s' : '闭合');
  col.append(el('div', { class: 'timeline', style: 'padding:6px 0 28px' }, track));
  col.append(el('div', { class: 'small muted', style: 'padding:0 2px 8px' },
    `启动 ${test.start_move_ms ?? '—'}ms ｜ 进入锁口 ${test.latch_ms ?? '—'}ms ｜ 完全关闭 ${test.closed_ms ?? '—'}ms`,
    over ? el('span', { class: 'tag-red' }, '（超过 5s，疑似无法闭合）') : null,
    test.closed_ms != null && test.closed_ms < 2000 ? el('span', { class: 'tag-red' }, '（撞击过快）') : null));
  return col;
}

function closeTestGroups(tests) {
  // 双扇门 A/B 两条记录通常在同一时刻分别写入，毫秒可能略有差异；
  // 按时间排序后，将 5 秒内相邻的 A/B 扇归为同一次测试。
  const sorted = [...tests].sort((a, b) => new Date(a.at) - new Date(b.at));
  const groups = [];
  for (const t of sorted) {
    const last = groups[groups.length - 1];
    const sameGroup = last && t.leaf !== 'S' &&
      Math.abs(new Date(t.at) - new Date(last[0].at)) < 5000 &&
      !last.some(x => x.leaf === t.leaf) && last.some(x => x.leaf !== 'S');
    if (sameGroup) last.push(t);
    else groups.push([t]);
  }
  // 保持最近优先
  groups.sort((g1, g2) => new Date(g2[0].at) - new Date(g1[0].at));
  return groups.map(g => [g[0].at, g]);
}

function sequenceVerdict(group) {
  const a = group.find(t => t.leaf === 'A');
  const b = group.find(t => t.leaf === 'B');
  if (!a || !b || a.latch_ms == null || b.latch_ms == null) return null;
  const ok = b.latch_ms < a.latch_ms;
  return el('div', { class: `seq-verdict ${ok ? 'ok' : 'bad'}` },
    ok ? `✓ 顺序正确：B 扇 ${b.latch_ms}ms 先行入锁，A 扇 ${a.latch_ms}ms 随后闭合`
       : `✗ 顺序错误：A 扇 ${a.latch_ms}ms 先于 B 扇 ${b.latch_ms}ms 入锁，须检修顺位器`);
}

// ---------- 临时措施横幅 ----------
function measureBanner(d, onChange) {
  const m = d.active_measure;
  if (m) {
    const leftH = Math.max(0, (new Date(m.expire_at) - Date.now()) / 3600_000);
    const txt = leftH > 0 ? `${leftH.toFixed(1)} 小时后到期` : '已到期，等待调度处理';
    return el('div', { class: 'measure-banner', id: 'measure-banner' },
      el('div', { class: 'ico' }, '🚧'),
      el('div', { class: 'body' },
        el('div', { class: 't' }, '临时措施生效中：门体临时封控，禁止恢复正常使用'),
        el('div', {}, m.reason),
        el('div', { class: 'meta' }, `批准人：见记录 · 批准于 ${fmtDT(m.approved_at)} · `,
          el('span', { class: 'countdown' }, txt))),
      el('button', {
        class: 'btn sm', onclick: () => revokeModal(m, onChange),
      }, '提前解除'));
  }
  // 最近一条已结束措施，仍在顶部以灰色持续提示
  const last = (d.events || []).find(e => ['temp_approved', 'temp_expired'].includes(e.type));
  return null;
}

// ---------- 主渲染 ----------
export async function renderDoorDetail(root, id, { route } = {}) {
  const d = await api(`/api/doors/${id}`);
  root.innerHTML = '';
  root.append(el('p', {}, el('a', { href: 'javascript:history.back()' }, '← 返回'),
    '　', el('a', { href: '#/doors' }, '门体列表')));

  // 临时措施始终在门体详情顶部
  const banner = measureBanner(d, () => route ? route() : location.reload());
  if (banner) root.append(banner);

  const head = el('div', { class: 'card' },
    el('div', { class: 'door-head' },
      el('div', {},
        el('h1', { class: 'page-title', style: 'margin-bottom:2px' },
          d.code, ' ', d.name,
          d.decommissioned ? badge('已停用', 'decommissioned') : null),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px' },
          badge(DOOR_STATUS_LABEL[d.status], d.status),
          badge(`${d.building_name} · ${d.zone_code} ${d.floor}`, 'neutral'),
          badge(d.door_type === 'NO' ? '常开防火门（断电释放）' : '常闭防火门（保持关闭）', d.door_type === 'NO' ? 'reset_failed' : 'neutral'),
          badge(d.leaf_count === 2 ? '双扇（带顺位器）' : '单扇', 'neutral'),
          badge(`封堵：${SEAL_LABEL[d.seal_status]}`, d.seal_status === 'sealed' ? 'sealed' : d.seal_status === 'none' ? 'neutral' : 'partial')),
      ),
      el('span', { style: 'margin-left:auto;display:flex;gap:8px;flex-wrap:wrap' },
        el('button', { class: 'btn', onclick: () => closeTestModal(d, route) }, '记录闭门测试'),
        d.door_type === 'NO' ? el('button', { class: 'btn', onclick: () => emSignalModal(d) }, '模拟释放联动') : null,
        el('button', { class: 'btn primary', onclick: () => reportFaultModal(route) }, '上报故障'),
        d.decommissioned
          ? el('button', { class: 'btn good', onclick: () => decommissionModal(d, false, route) }, '恢复启用')
          : el('button', { class: 'btn danger', onclick: () => decommissionModal(d, true, route) }, '停用标记'),
      )),
    el('hr', { class: 'sep' }),
    el('div', { class: 'kv' },
      kv('门体编号', d.code), kv('所在分区', `${d.zone_code} ${d.zone_name}`),
      kv('楼层', d.floor), kv('门体类型', d.door_type === 'NO' ? '常开' : '常闭'),
      kv('门扇数量', d.leaf_count === 2 ? '双扇' : '单扇'), kv('封堵情况', SEAL_LABEL[d.seal_status]),
      kv('未关闭故障', String(d.faults.filter(f => f.status !== 'closed').length)),
      kv('备注', d.note || '—')));
  root.append(head);

  // 部件
  const kindLabel = { closer: '闭门器', sequencer: '顺序器（顺位器）', em_release: '电磁释放器' };
  const compCard = el('div', { class: 'card' },
    el('h2', {}, '部件检查', el('span', { class: 'more muted' }, '闭门器 / 顺序器 / 电磁释放')),
    el('div', {}, d.components.map(c => el('span', { class: 'comp-chip' },
      `🔧 ${kindLabel[c.kind] || c.kind}`,
      el('span', { class: 'muted small mono' }, c.model),
      badge(c.status === 'ok' ? '正常' : '故障', c.status === 'ok' ? 'normal' : 'reset_failed')))));
  root.append(compCard);

  // 临时措施操作
  if (!d.active_measure && !d.decommissioned) {
    root.append(el('div', { class: 'card' },
      el('h2', {}, '临时措施'),
      el('p', { class: 'small muted' }, '门体待维修期间，可由安全主管批准临时封控等措施并设置到期时间；到期由系统自动失效并留痕。'),
      el('button', { class: 'btn', onclick: () => approveMeasureModal(d, route) }, '申请/批准临时措施')));
  }

  // 闭门测试时间刻度
  const groups = closeTestGroups(d.close_tests);
  const ctCard = el('div', { class: 'card' },
    el('h2', {}, '闭门测试 · 时间刻度',
      el('span', { class: 'more muted' }, '90° 释放后关闭过程；2s 内闭合为过快，超过 5s 为闭合困难')),
    groups.length === 0 ? el('p', { class: 'muted' }, '暂无闭门测试记录') :
      groups.map(([at, g], i) => el('div', { style: 'margin-bottom:14px' },
        el('div', { class: 'small muted', style: 'margin-bottom:4px' }, `第 ${groups.length - i} 次 · ${fmtDT(at)} · 来源：${refLabel(g[0].ref_type)}`),
        el('div', { class: g.length > 1 ? 'grid grid-2' : '' },
          g.some(t => t.leaf === 'A') ? closeLeafColumn(g.find(t => t.leaf === 'A')) : null,
          g.some(t => t.leaf === 'B') ? closeLeafColumn(g.find(t => t.leaf === 'B')) : null,
          g.some(t => t.leaf === 'S') ? closeLeafColumn(g.find(t => t.leaf === 'S')) : null),
        g.length > 1 ? sequenceVerdict(g) : null)));
  root.append(ctCard);

  // 故障 & 维修 & 复位 三栏
  const faultCard = el('div', { class: 'card' }, el('h2', {}, '故障记录'),
    faultTable(d.faults));
  const repairCard = el('div', { class: 'card' }, el('h2', {}, '维修单'),
    repairTable(d.repair_orders, d, route));
  const resetCard = el('div', { class: 'card' }, el('h2', {}, '复位测试'),
    resetTable(d.reset_tests));
  root.append(el('div', { class: 'grid grid-3' }, faultCard, repairCard, resetCard));

  // 照片
  const photoCard = el('div', { class: 'card' },
    el('h2', {}, '门体照片', el('span', { class: 'more' }, photoUpload(d, route))),
    el('div', { class: 'photo-grid' }, d.photos.map(p => el('figure', { style: 'margin:0' },
      el('img', { src: `/${p.path}`, alt: p.caption, loading: 'lazy' }),
      el('figcaption', {}, p.caption, ' · ', fmtDT(p.at))))));
  root.append(photoCard);

  // 事件留痕
  const eventCard = el('div', { class: 'card' }, el('h2', {}, '事件留痕'),
    el('ul', { class: 'feed' }, d.events.map(ev => el('li', {},
      el('span', { class: 't' }, fmtDT(ev.at)),
      el('span', { class: 'ty' }, badge(EVENT_LABEL[ev.type] || ev.type,
        ['reset_pass'].includes(ev.type) ? 'normal' : ['temp_approved', 'temp_expired'].includes(ev.type) ? 'temp_blocked' : 'neutral')),
      el('span', { class: 'small' }, eventDetail(ev))))));
  root.append(eventCard);
}

function refLabel(t) {
  return { inspection: '路线巡检', reset: '复位测试', manual: '手动测试' }[t] || t;
}
function kv(k, v) { return el('div', {}, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v)); }

function eventDetail(ev) {
  let extra = '';
  try { const j = JSON.parse(ev.detail || '{}'); extra = j.note || j.reason || j.work_note || (j.message ? j.message : ''); } catch {}
  return `${EVENT_LABEL[ev.type] || ev.type}${ev.actor_name ? ' · ' + ev.actor_name : ''}${extra ? '｜' + extra : ''}`;
}

function faultTable(faults) {
  if (!faults.length) return el('p', { class: 'muted' }, '无故障记录');
  return el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ...['单号', '类别', '上报时间', '状态'].map(h => el('th', {}, h)))),
    el('tbody', {}, faults.map(f => el('tr', {},
      el('td', { class: 'code-link' }, f.code),
      el('td', {}, FAULT_KIND_LABEL[f.kind] || f.kind),
      el('td', { class: 'small' }, fmtDT(f.reported_at)),
      el('td', {}, badge(FAULT_STATUS_LABEL[f.status], f.status))))));
}

function repairTable(orders, d, route) {
  if (!orders.length) return el('p', { class: 'muted' }, '无维修单');
  return el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ...['单号', '负责人', '状态', '操作'].map(h => el('th', {}, h)))),
    el('tbody', {}, orders.map(o => el('tr', {},
      el('td', { class: 'code-link' }, o.code),
      el('td', { class: 'small' }, o.assignee_name || '—'),
      el('td', {}, badge({ open: '待开工', in_progress: '维修中', done: '已完工', cancelled: '已取消' }[o.status],
        o.status === 'done' ? 'pending' : 'neutral')),
      el('td', {}, repairMiniActions(o, d, route))))));
}

function repairMiniActions(o, d, route) {
  const box = el('span', { style: 'display:flex;gap:4px;flex-wrap:wrap' });
  const go = () => { location.hash = '#/repairs'; };
  if (o.status === 'open') box.append(el('button', { class: 'btn sm', onclick: () => wrap(async () => { await api(`/api/repair-orders/${o.id}/start`, { body: {} }); route(); }, '已开工') }, '开工'));
  if (o.status === 'in_progress') box.append(el('button', { class: 'btn sm good', onclick: go }, '完工'));
  if (o.status === 'done') {
    box.append(el('button', {
      class: 'btn sm primary',
      onclick: () => resetTestModal({ ...o, door_code: d.code }).then(() => route()),
    }, '复位测试'));
  }
  return box;
}

function resetTable(tests) {
  if (!tests.length) return el('p', { class: 'muted' }, '无复位测试');
  return el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ...['单号', '测试人', '结果'].map(h => el('th', {}, h)))),
    el('tbody', {}, tests.map(t => {
      const items = JSON.parse(t.items);
      const fails = Object.entries(items).filter(([, v]) => v === 'fail').map(([k]) => RESET_ITEM_LABEL[k]);
      return el('tr', {},
        el('td', { class: 'code-link' }, t.code),
        el('td', { class: 'small' }, t.tester_name),
        el('td', {}, badge(t.result === 'pass' ? '合格' : '退回', t.result === 'pass' ? 'normal' : 'reset_failed'),
          fails.length ? el('div', { class: 'small muted' }, fails.join('、')) : null));
    })));
}

// ---------- 弹窗 ----------
function approveMeasureModal(d, route) {
  if (!requireRole(['safety_manager', 'admin'], '仅安全主管可批准临时措施')) return;
  const openFault = d.faults.find(f => f.status !== 'closed');
  const reason = el('textarea', { rows: 3, placeholder: '如：闭门器断裂，设置护栏与警示带临时封控' });
  const hours = el('input', { type: 'number', value: '24', min: 1, max: 720 });
  const { close } = modal({
    title: `批准临时措施 · ${d.code}`,
    body: el('div', {},
      el('div', { class: 'section-note' }, '临时措施到期后系统自动解除、门体回到待维修并留痕；复位合格时也会自动解除。'),
      el('label', { class: 'fld' }, '措施说明', reason),
      el('label', { class: 'fld', style: 'margin-top:10px' }, '有效时长（小时）', hours)),
    footer: [el('button', {
      class: 'btn primary', onclick: () => wrap(async () => {
        await api(`/api/doors/${d.id}/temp-measures`, {
          body: { reason: reason.value, expireHours: Number(hours.value), faultId: openFault?.id ?? null },
        });
        close(); route(); toast('临时措施已批准生效', 'ok');
      }),
    }, '批准')],
  });
}

function revokeModal(measure, route) {
  const note = el('input', { placeholder: '解除原因（可选）' });
  const { close } = modal({
    title: '提前解除临时措施',
    body: el('div', {}, el('p', { class: 'small' }, '解除后门体回到待维修/正常状态。'), note),
    footer: [el('button', {
      class: 'btn primary', onclick: () => wrap(async () => {
        await api(`/api/temp-measures/${measure.id}/revoke`, { body: { note: note.value } });
        close(); route(); toast('临时措施已解除', 'ok');
      }),
    }, '确认解除')],
  });
}

function decommissionModal(d, active, route) {
  if (!requireRole(['safety_manager', 'admin'], '仅安全主管可停用/恢复门体')) return;
  if (active) {
    const reason = el('textarea', { rows: 2, placeholder: '停用原因，如：管井废弃、砌体封堵' });
    const seal = el('select', {},
      el('option', { value: 'partial' }, '部分封堵'),
      el('option', { value: 'sealed' }, '完全封堵'),
      el('option', { value: 'none' }, '未封堵（仅停用）'));
    const { close } = modal({
      title: `停用标记 · ${d.code}`,
      body: el('div', { class: 'section-note' }, '停用门体不参与巡检、不可上报故障；有进行中维修单时无法停用。',
        el('div', { style: 'margin-top:10px' }, el('label', { class: 'fld' }, '封堵情况', seal)),
        el('div', { style: 'margin-top:10px' }, el('label', { class: 'fld' }, '停用原因', reason))),
      footer: [el('button', {
        class: 'btn danger', onclick: () => wrap(async () => {
          await api(`/api/doors/${d.id}/decommission`, { body: { reason: reason.value, seal: seal.value } });
          close(); route(); toast('门体已停用并标记', 'ok');
        }),
      }, '确认停用')],
    });
  } else {
    const { close } = modal({
      title: `恢复启用 · ${d.code}`,
      body: el('p', {}, '确认清除停用标记并恢复为正常状态？'),
      footer: [el('button', {
        class: 'btn primary', onclick: () => wrap(async () => {
          await api(`/api/doors/${d.id}/reactivate`, { body: {} });
          close(); route(); toast('门体已恢复', 'ok');
        }),
      }, '确认恢复')],
    });
  }
}

function closeTestModal(d, route) {
  if (!requireRole(['inspector', 'safety_manager', 'admin'])) return;
  const makeInputs = (leaf, title) => {
    const sm = el('input', { type: 'number', min: 0, value: 260, style: 'width:90px' });
    const lm = el('input', { type: 'number', min: 0, value: 2400, style: 'width:90px' });
    const cm = el('input', { type: 'number', min: 0, value: 2700, style: 'width:90px' });
    return el('div', { class: 'leaf-col' },
      el('h4', {}, title),
      el('div', { class: 'form-grid' },
        el('label', { class: 'fld' }, '开始动作 (ms)', sm),
        el('label', { class: 'fld' }, '进入锁口 (ms)', lm),
        el('label', { class: 'fld full' }, '完全关闭 (ms)，<2000 过快，>30000 不合格', cm)),
      el('div', { dataset: { fields: '1' }, style: 'display:none' }, JSON.stringify({ leaf })),
      sm, lm, cm);
  };
  let cols;
  if (d.leaf_count === 2) {
    const a = makeInputs('A', 'A 扇（先开/后闭）');
    const b = makeInputs('B', 'B 扇（后开/先闭）');
    // B 扇默认先入锁
    a.querySelectorAll('input')[1].value = 2700; a.querySelectorAll('input')[2].value = 3000;
    b.querySelectorAll('input')[1].value = 2350; b.querySelectorAll('input')[2].value = 2650;
    cols = el('div', { class: 'grid grid-2' }, a, b);
  } else {
    cols = makeInputs('S', '单扇');
  }
  const { close } = modal({
    title: `记录闭门测试 · ${d.code}（90° 释放）`,
    body: el('div', {},
      el('div', { class: 'section-note' }, '以释放瞬间为 0ms，记录门扇开始动作、进入锁口与完全关闭时刻；双扇须分别记录以判定关闭顺序。'),
      cols),
    footer: [el('button', {
      class: 'btn primary', onclick: () => wrap(async () => {
        const tests = [...cols.querySelectorAll('.leaf-col')].map(col => {
          const leaf = JSON.parse(col.querySelector('[data-fields]').textContent).leaf;
          const [sm, lm, cm] = col.querySelectorAll('input');
          return { leaf, startMoveMs: Number(sm.value), latchMs: Number(lm.value), closedMs: Number(cm.value) };
        });
        const r = await api(`/api/doors/${d.id}/close-tests`, { body: { tests } });
        close(); route();
        if (r.sequence && r.sequence.ok === false) toast('双扇顺序错误：B 扇未先于 A 扇闭合', 'err');
        else if (r.tests.some(t => t.result === 'fail')) toast('闭门测试不合格（过快或无法闭合）', 'err');
        else toast('闭门测试已记录，结果合格', 'ok');
      }),
    }, '保存测试')],
  });
}

async function emSignalModal(d) {
  const box = el('div', {},
    el('p', { class: 'small muted' }, '向消防联动主机下发释放指令，由模拟适配器回传信号；可注入联动故障以演练“复位退回 → 维修 → 复测合格”。'),
    el('div', { class: 'check-item', style: 'margin:8px 0' },
      '适配器脚本',
      el('select', { id: 'em-mode' },
        el('option', { value: 'ok' }, '正常回传'),
        el('option', { value: 'no_feedback' }, '故障：信号无回传'),
        el('option', { value: 'no_release' }, '故障：释放器不动作')),
      el('button', {
        class: 'btn sm', onclick: () => wrap(async () => {
          const mode = document.getElementById('em-mode').value;
          const r = await api(`/api/em-release/${d.code}/configure`, { body: { mode } });
          toast(r.message, mode === 'ok' ? 'ok' : 'err');
        }),
      }, '应用脚本')));
  const { close } = modal({
    title: `电磁释放联动测试 · ${d.code}`,
    body: box,
    footer: [
      el('button', { class: 'btn ghost', onclick: () => close() }, '关闭'),
      el('button', {
        class: 'btn primary', onclick: async () => wrap(async () => {
          const sig = await api(`/api/em-release/${d.code}`, { body: {} });
          box.append(el('div', { class: `signal-box ${sig.ok ? 'ok' : 'bad'}`, style: 'margin-top:10px' },
            el('div', {}, sig.ok ? '✓ ' : '✗ ', sig.message),
            el('div', { class: 'muted small mono', style: 'margin-top:4px' },
              `指令 ${sig.command} · released=${sig.released ?? 'null'} · closed=${sig.closed ?? 'null'} · ${sig.at}`)));
        }, '信号已采集'),
      }, '下发释放指令')],
  });
}

function photoUpload(d, route) {
  const inp = el('input', { type: 'file', accept: 'image/*,image/svg+xml', style: 'display:none' });
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('caption', `巡检上传 ${new Date().toLocaleString('zh-CN')}`);
    fd.append('file', f);
    await wrap(async () => {
      await api(`/api/doors/${d.id}/photos`, { body: fd });
      route(); toast('照片已上传', 'ok');
    });
  };
  return el('span', {}, inp, el('button', { class: 'btn sm', onclick: () => inp.click() }, '上传照片'));
}
