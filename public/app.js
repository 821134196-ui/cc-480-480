import {
  api, state, setActor, actor, ROLE_LABEL, DOOR_STATUS_LABEL, FAULT_STATUS_LABEL,
  FAULT_KIND_LABEL, EVENT_LABEL, SEAL_LABEL, RESET_ITEM_LABEL,
} from './api.js';
import { el, badge, fmtDT, toast, modal, requireRole, wrap } from './ui.js';
import { renderDoorDetail } from './door.js';

const view = document.getElementById('view');
const navEl = document.getElementById('mainnav');

const NAV = [
  { hash: '#/overview', label: '总览' },
  { hash: '#/map', label: '防火分区图' },
  { hash: '#/inspections', label: '路线巡检' },
  { hash: '#/doors', label: '门体部件' },
  { hash: '#/faults', label: '故障列表' },
  { hash: '#/repairs', label: '维修进度' },
  { hash: '#/resets', label: '复位测试' },
  { hash: '#/overdue', label: '逾期统计' },
];

export function fmtHM(s) {
  if (!s) return '—';
  const d = new Date(s);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function hoursLeft(expireIso) {
  return Math.max(0, (new Date(expireIso) - Date.now()) / 3600_000);
}

// ---------- 导航 / 操作人 ----------
function renderNav(current) {
  navEl.innerHTML = '';
  for (const n of NAV) {
    navEl.append(el('a', {
      href: n.hash, class: current.startsWith(n.hash) ? 'active' : '',
    }, n.label));
  }
}

async function renderActor() {
  const sel = document.getElementById('actorSelect');
  sel.innerHTML = '';
  sel.append(el('option', { value: '' }, '— 请选择 —'));
  for (const u of state.users) {
    const zones = JSON.parse(u.zone_ids || '[]');
    sel.append(el('option', { value: u.id, selected: u.id === state.actorId },
      `${u.name}（${ROLE_LABEL[u.role]}${zones.length ? '·限授权分区' : ''}）`));
  }
  sel.onchange = async () => {
    setActor(sel.value ? Number(sel.value) : null);
    document.getElementById('actorMeta').textContent = '';
    route();
  };
  const a = actor();
  document.getElementById('actorMeta').textContent = a
    ? (JSON.parse(a.zone_ids).length ? '区域受限' : '全域权限') : '';
}

// ---------- 路由 ----------
async function route() {
  const hash = location.hash || '#/overview';
  renderNav(hash);
  const [, path, arg] = hash.match(/^#\/([^/]+)(?:\/(.+))?/) || [];
  view.innerHTML = '<p class="muted" style="padding:40px">加载中…</p>';
  const a = actor();
  try {
    switch (path) {
      case 'overview': await pageOverview(); break;
      case 'map': await pageMap(); break;
      case 'inspections': arg ? await pageInspection(Number(arg)) : await pageInspections(); break;
      case 'doors': arg ? await renderDoorDetail(view, Number(arg), { route }) : await pageDoors(); break;
      case 'faults': await pageFaults(); break;
      case 'repairs': await pageRepairs(); break;
      case 'resets': await pageResets(); break;
      case 'overdue': await pageOverdue(); break;
      default: await pageOverview();
    }
  } catch (e) {
    view.innerHTML = '';
    view.append(el('div', { class: 'card' }, el('h2', {}, '加载失败'), el('p', {}, e.message)));
  }
}

// ---------- 总览 ----------
async function pageOverview() {
  const [ov, events, reminders, zones] = await Promise.all([
    api('/api/overview'), api('/api/events'), api('/api/reminders'), api('/api/zones'),
  ]);
  const stat = (v, l, cls = '', sub = '') =>
    el('div', { class: `stat ${cls}` }, el('div', { class: 'v' }, String(v)),
      el('div', { class: 'l' }, l), sub ? el('div', { class: 'sub' }, sub) : null);

  const abnormalZones = zones.filter(z => z.abnormal_count > 0);
  view.append(
    el('h1', { class: 'page-title' }, '运行总览'),
    el('p', { class: 'page-sub' }, '云锦花园 1 号楼 · 门体状态、故障维修、复位与逾期一屏掌握'),
    el('div', { class: 'grid grid-4' },
      stat(ov.doors_normal, '正常门体', 'good', `共 ${ov.doors_total} 樘 / ${ov.zones} 个分区`),
      stat(ov.doors_fault_open, '故障未闭环', 'red', '待维修/维修中/复位退回'),
      stat(ov.doors_temp_blocked, '临时封控', 'warn', '安全主管批准措施生效中'),
      stat(ov.doors_decommissioned, '停用门体', '', '已做封堵标记'),
      stat(ov.faults_open, '未关闭故障', 'red'),
      stat(ov.repairs_active, '进行中维修单', '', `${ov.repairs_overdue} 单超时`),
      stat(ov.resets_failed, '复位退回次数', 'crit', '须返修后重新复位'),
      stat(ov.inspections_open, '未完成巡检', '', `${ov.inspections_overdue} 任务逾期`),
    ),
  );

  const zoneCard = el('div', { class: 'card' },
    el('h2', {}, '防火分区', el('a', { class: 'more', href: '#/map' }, '查看分区图 →')),
    el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {},
        el('th', {}, '分区编号'), el('th', {}, '名称'), el('th', {}, '楼层'),
        el('th', { class: 'num' }, '门体'), el('th', { class: 'num' }, '异常'), el('th', {}, ''))),
      el('tbody', {}, zones.map(z => el('tr', {},
        el('td', { class: 'code-link' }, z.code), el('td', {}, z.name), el('td', {}, z.floor),
        el('td', { class: 'num' }, String(z.door_count)),
        el('td', { class: 'num' }, z.abnormal_count
          ? el('span', { class: 'tag-red' }, String(z.abnormal_count)) : '0'),
        el('td', {}, el('a', { href: `#/map` }, '图上定位')))))));

  const feed = el('ul', { class: 'feed' },
    events.slice(0, 14).map(ev => el('li', {},
      el('span', { class: 't' }, fmtDT(ev.at)),
      el('span', { class: 'ty' }, badge(EVENT_LABEL[ev.type] || ev.type,
        ['reset_pass'].includes(ev.type) ? 'normal' : ['reset_fail', 'wedged', 'repair_overdue', 'decommission'].includes(ev.type) ? 'reset_failed' : 'neutral')),
      el('span', {}, ev.door_code ? `${ev.door_code} ` : '', (() => { try { return JSON.parse(ev.detail).note || JSON.parse(ev.detail).reason || ''; } catch { return ''; } })()),
      el('span', { class: 'muted small' }, ev.actor_name ? `· ${ev.actor_name}` : ''))));

  const pendingRem = reminders.filter(r => !r.fired);
  const remCard = el('div', { class: 'card' },
    el('h2', {}, '进程内提醒', el('span', { class: 'more muted' }, '巡检到期 / 维修超时 / 临时措施到期')),
    pendingRem.length
      ? el('ul', { class: 'feed' }, pendingRem.slice(0, 10).map(r => el('li', {},
        el('span', { class: 't' }, fmtDT(r.at)),
        el('span', {}, r.message))))
      : el('p', { class: 'muted' }, '暂无待触发提醒'));

  view.append(el('div', { class: 'grid grid-2' }, zoneCard,
    el('div', {}, remCard,
      el('div', { class: 'card' }, el('h2', {}, '最近事件留痕'), feed))));

  if (abnormalZones.length) {
    // 提示条
  }
}

// ---------- 分区图 ----------
async function pageMap() {
  const data = await api('/api/zone-map');
  view.append(
    el('h1', { class: 'page-title' }, '防火分区图'),
    el('p', { class: 'page-sub' }, '门体以短线 + 编号标注，颜色表示实时状态；点击门体进入详情'),
  );
  const card = el('div', { class: 'card' });
  const maxX = Math.max(...data.zones.map(z => z.px + z.pw)) + 60;
  const maxY = Math.max(...data.zones.map(z => z.py + z.ph)) + 40;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('style', 'min-width:760px;');

  const byZone = new Map(data.doors.map(d => [d.zone_id, []]));
  data.doors.forEach(d => byZone.get(d.zone_id)?.push(d));

  for (const z of data.zones) {
    const g = document.createElementNS(svgNS, 'g');
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', z.px); rect.setAttribute('y', z.py);
    rect.setAttribute('width', z.pw); rect.setAttribute('height', z.ph);
    rect.setAttribute('rx', 8); rect.setAttribute('class', 'zone-rect');
    g.append(rect);
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', z.px + 12); label.setAttribute('y', z.py + 22);
    label.setAttribute('class', 'zone-label'); label.textContent = `${z.code} ${z.name}`;
    g.append(label);
    const floor = document.createElementNS(svgNS, 'text');
    floor.setAttribute('x', z.px + 12); floor.setAttribute('y', z.py + 38);
    floor.setAttribute('class', 'zone-floor'); floor.textContent = z.floor;
    g.append(floor);
    for (const d of byZone.get(z.id) || []) {
      const dg = document.createElementNS(svgNS, 'g');
      dg.setAttribute('class', 'door-mark');
      dg.style.cursor = 'pointer';
      const rad = (d.gangle * Math.PI) / 180;
      const x1 = d.gx - Math.cos(rad) * d.glen / 2, y1 = d.gy - Math.sin(rad) * d.glen / 2;
      const x2 = d.gx + Math.cos(rad) * d.glen / 2, y2 = d.gy + Math.sin(rad) * d.glen / 2;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', x1); line.setAttribute('y1', y1);
      line.setAttribute('x2', x2); line.setAttribute('y2', y2);
      line.setAttribute('class', `door-line ${d.status}`);
      dg.append(line);
      const txt = document.createElementNS(svgNS, 'text');
      const lx = d.gx + Math.sin(rad) * 12 + 4, ly = d.gy - Math.cos(rad) * 12 + 3;
      txt.setAttribute('x', lx); txt.setAttribute('y', ly);
      txt.setAttribute('class', `door-code ${d.door_type === 'NO' ? 'door-no-tag' : ''}`);
      txt.textContent = d.code.replace(/^FM-/, '');
      dg.append(txt);
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = `${d.code} ${d.name}｜${DOOR_STATUS_LABEL[d.status]}${d.door_type === 'NO' ? '｜常开' : '｜常闭'}${d.leaf_count === 2 ? '｜双扇' : ''}`;
      dg.append(title);
      dg.addEventListener('click', () => { location.hash = `#/doors/${d.id}`; });
      g.append(dg);
    }
    svg.append(g);
  }
  card.append(el('div', { class: 'map-wrap' }, svg));
  card.append(el('div', { class: 'legend' },
    legendItem('#3d3b37', '正常'),
    legendItem('#365f8c', '待维修/维修中/待复位'),
    legendItem('#c25a2f', '临时封控'),
    legendItem('#d03b3b', '复位退回'),
    legendItem('#b7b2a8', '停用（虚线）'),
    el('span', { class: 'muted' }, '红色编号 = 常开防火门（配电磁释放器）'),
  ));
  view.append(card);
}
function legendItem(color, label) {
  return el('span', {}, el('i', { style: `border-color:${color};color:${color}` }), label);
}

// ---------- 门体 / 部件列表 ----------
async function pageDoors() {
  const doors = await api('/api/doors');
  view.append(
    el('h1', { class: 'page-title' }, '门体与部件'),
    el('p', { class: 'page-sub' }, '按楼栋、防火分区维护门体编号、常开/常闭类型、闭门器 / 顺序器 / 电磁释放器与封堵情况'),
  );
  const filter = el('select', {},
    el('option', { value: '' }, '全部状态'),
    ...Object.entries(DOOR_STATUS_LABEL).map(([k, v]) => el('option', { value: k }, v)));
  const kw = el('input', { placeholder: '搜索门体编号 / 名称', style: 'width:220px' });
  const card = el('div', { class: 'card' });
  const draw = () => {
    const f = filter.value, q = kw.value.trim().toLowerCase();
    const rows = doors.filter(d => (!f || d.status === f) &&
      (!q || d.code.toLowerCase().includes(q) || d.name.toLowerCase().includes(q)));
    card.innerHTML = '';
    card.append(el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {},
        ...['门体编号', '名称', '分区/楼层', '类型', '扇', '状态', '封堵', '未关闭故障', ''].map(h => el('th', {}, h)))),
      el('tbody', {}, rows.map(d => el('tr', {},
        el('td', { class: 'code-link' }, el('a', { href: `#/doors/${d.id}` }, d.code)),
        el('td', {}, d.decommissioned ? el('span', {}, d.name, ' ', badge('停用', 'decommissioned')) : d.name),
        el('td', {}, `${d.zone_code} · ${d.floor}`),
        el('td', {}, d.door_type === 'NO'
          ? el('span', { class: 'dot-txt tag-red' }, '常开') : el('span', { class: 'dot-txt muted' }, '常闭')),
        el('td', {}, d.leaf_count === 2 ? '双扇' : '单扇'),
        el('td', {}, badge(DOOR_STATUS_LABEL[d.status], d.status)),
        el('td', {}, d.seal_status === 'none' ? '—' : badge(SEAL_LABEL[d.seal_status], d.seal_status === 'sealed' ? 'sealed' : 'partial')),
        el('td', { class: 'num' }, d.open_fault_count ? el('span', { class: 'tag-red' }, String(d.open_fault_count)) : '0'),
        el('td', {}, el('a', { class: 'btn sm', href: `#/doors/${d.id}` }, '详情')))))));
  };
  filter.onchange = draw; kw.oninput = draw;
  view.append(el('div', { class: 'toolbar' }, filter, kw, el('span', { class: 'spacer' }),
    el('span', { class: 'muted small' }, `共 ${doors.length} 樘门`)));
  draw();
  view.append(card);
}

// ---------- 故障列表 ----------
async function pageFaults() {
  const faults = await api('/api/faults');
  view.append(el('h1', { class: 'page-title' }, '故障列表'),
    el('p', { class: 'page-sub' }, '巡检发现或人工上报；同一门体同类未关闭故障不重复开单；故障闭环须经维修 + 他人复位合格'));
  const filter = el('select', {},
    el('option', { value: '' }, '全部状态'),
    ...Object.entries(FAULT_STATUS_LABEL).map(([k, v]) => el('option', { value: k }, v)));
  const kindSel = el('select', {}, el('option', { value: '' }, '全部类别'),
    ...Object.entries(FAULT_KIND_LABEL).map(([k, v]) => el('option', { value: k }, v)));
  const onlyOpen = el('input', { type: 'checkbox' });
  const card = el('div', { class: 'card' });
  const draw = () => {
    const rows = faults.filter(f =>
      (!filter.value || f.status === filter.value) &&
      (!kindSel.value || f.kind === kindSel.value) &&
      (!onlyOpen.checked || f.status !== 'closed'));
    card.innerHTML = '';
    card.append(el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ...['工单号', '门体', '类别', '上报', '时间', '状态', '维修单', ''].map(h => el('th', {}, h)))),
      el('tbody', {}, rows.map(f => el('tr', { class: f.status === 'reset_failed' ? 'overdue-row' : '' },
        el('td', { class: 'code-link' }, f.code),
        el('td', {}, el('a', { href: `#/doors/${f.door_id}` }, f.door_code), ' ', el('span', { class: 'muted small' }, f.door_name)),
        el('td', {}, FAULT_KIND_LABEL[f.kind] || f.kind),
        el('td', {}, f.reporter_name || '—'),
        el('td', { class: 'small' }, fmtDT(f.reported_at)),
        el('td', {}, badge(FAULT_STATUS_LABEL[f.status], f.status)),
        el('td', { class: 'code-link' }, f.order_code || '—'),
        el('td', {}, el('a', { class: 'btn sm', href: `#/doors/${f.door_id}` }, '处理')))))));
  };
  filter.onchange = kindSel.onchange = draw;
  onlyOpen.onchange = draw; onlyOpen.checked = true; draw();
  view.append(el('div', { class: 'toolbar' }, filter, kindSel,
    el('label', { class: 'checklist-single small' }, onlyOpen, '仅未关闭'),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn primary', onclick: () => reportFaultModal(draw) }, '＋ 上报故障')));
  view.append(card);
}

async function reportFaultModal(after) {
  if (!requireRole(['inspector', 'safety_manager', 'admin'])) return;
  const doors = await api('/api/doors');
  const doorSel = el('select', {}, ...doors.map(d => el('option', { value: d.id },
    `${d.code} ${d.name}（${DOOR_STATUS_LABEL[d.status]}）`)));
  const kindSel = el('select', {},
    ...Object.entries(FAULT_KIND_LABEL).filter(([k]) => k !== 'reset_fail').map(([k, v]) => el('option', { value: k }, v)));
  const note = el('textarea', { rows: 3, placeholder: '故障现象、位置、风险描述' });
  const { close } = await modal({
    title: '上报故障工单',
    body: el('div', { class: 'form-grid' },
      el('label', { class: 'fld' }, '门体', doorSel),
      el('label', { class: 'fld' }, '故障类别', kindSel),
      el('label', { class: 'fld full' }, '现象描述', note)),
    footer: [
      el('button', {
        class: 'btn primary', onclick: async () => wrap(async () => {
          await api('/api/faults', { body: { doorId: Number(doorSel.value), kind: kindSel.value, note: note.value } });
          close(); after?.(); toast('故障已上报', 'ok');
        }),
      }, '提交工单'),
    ],
  });
}

export { reportFaultModal };

// ---------- 维修进度 ----------
async function pageRepairs() {
  const [orders, faults] = await Promise.all([api('/api/repair-orders'), api('/api/faults?open=1')]);
  view.append(el('h1', { class: 'page-title' }, '维修进度'),
    el('p', { class: 'page-sub' }, '同一门体同时只能有一张进行中维修单；完工后必须由维修人之外的另一人复位测试，全部合格才闭环'));
  const stat = (v, l, c) => el('div', { class: `stat ${c}` }, el('div', { class: 'v' }, String(v)), el('div', { class: 'l' }, l));
  view.append(el('div', { class: 'grid grid-4' },
    stat(orders.filter(o => ['open', 'in_progress'].includes(o.status)).length, '进行中', ''),
    stat(orders.filter(o => o.overdue).length, '已超时', 'red'),
    stat(orders.filter(o => o.status === 'done').length, '待/已复位', 'warn'),
    stat(faults.filter(f => f.status === 'reset_failed').length, '复位退回', 'crit')));

  const card = el('div', { class: 'card' });
  card.append(el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {},
      ...['维修单号', '门体', '故障', '负责人', '创建', '时限', '状态', '复位退回', '操作'].map(h => el('th', {}, h)))),
    el('tbody', {}, orders.map(o => el('tr', { class: o.overdue ? 'overdue-row' : '' },
      el('td', { class: 'code-link' }, o.code),
      el('td', {}, el('a', { href: `#/doors/${o.door_id}` }, o.door_code)),
      el('td', {}, FAULT_KIND_LABEL[o.fault_kind] || o.fault_kind),
      el('td', {}, o.assignee_name || '—'),
      el('td', { class: 'small' }, fmtDT(o.created_at)),
      el('td', { class: 'small' }, o.overdue ? badge(`超时 ${o.overdue_hours?.toFixed(1)}h`, 'repair_overdue') : fmtDT(o.due_at)),
      el('td', {}, badge({ open: '待开工', in_progress: '维修中', done: '已完工待复位', cancelled: '已取消' }[o.status],
        o.status === 'done' ? 'pending' : o.overdue ? 'temp_blocked' : 'neutral')),
      el('td', { class: 'num' }, o.reset_failure_count ? el('span', { class: 'tag-red' }, String(o.reset_failure_count)) : '0'),
      el('td', {}, repairActions(o)))))));
  view.append(card);

  function repairActions(o) {
    const box = el('span', { style: 'display:inline-flex;gap:6px' });
    const a = actor();
    if (o.status === 'open') {
      box.append(el('button', {
        class: 'btn sm', onclick: () => wrap(async () => { await api(`/api/repair-orders/${o.id}/start`, { body: {} }); route(); }, '已开工'),
      }, '开工'));
    } else if (o.status === 'in_progress') {
      box.append(el('button', {
        class: 'btn sm good', onclick: () => completeRepairModal(o),
      }, '填报完工'));
    } else if (o.status === 'done') {
      box.append(el('button', {
        class: `btn sm ${a && a.id !== o.assignee_id ? 'primary' : ''}`,
        title: a && a.id === o.assignee_id ? '维修人不能复位自己的维修单' : '',
        onclick: () => resetTestModal(o),
      }, a && a.id === o.assignee_id ? '复位（需他人）' : '执行复位测试'));
    }
    box.append(el('a', { class: 'btn sm ghost', href: `#/doors/${o.door_id}` }, '门体'));
    return box;
  }
}

async function completeRepairModal(o) {
  const note = el('textarea', { rows: 3, placeholder: '维修内容、更换部件、调试情况' });
  const { close } = await modal({
    title: `维修完工 ${o.code}`,
    body: el('div', {},
      el('div', { class: 'section-note' }, '完工后门体进入「待复位」，由另一名巡检员/安全主管执行复位测试，合格前不得恢复正常。'),
      el('label', { class: 'fld' }, '维修记录', note)),
    footer: [el('button', {
      class: 'btn primary', onclick: () => wrap(async () => {
        await api(`/api/repair-orders/${o.id}/complete`, { body: { workNote: note.value } });
        close(); route(); toast('已填报完工，等待复位测试', 'ok');
      }),
    }, '确认完工')],
  });
}

export async function resetTestModal(o) {
  const me = actor();
  if (!me) return toast('请先选择操作人', 'err');
  if (me.id === o.assignee_id) return toast('维修人不能对自己的维修单执行复位测试，须由另一人执行', 'err');
  if (!['inspector', 'safety_manager', 'admin'].includes(me.role)) return toast('复位测试须由巡检员或安全主管执行', 'err');
  const door = await api(`/api/doors/${o.door_id}`);
  const applies = door.applicable_reset_items;
  const itemEls = {};
  const rows = Object.entries(applies).map(([k, required]) => {
    if (!required) return null;
    const sel = el('select', {}, el('option', { value: 'pass' }, '✓ 合格'), el('option', { value: 'fail' }, '✗ 不合格'));
    itemEls[k] = sel;
    return el('div', { class: 'check-item' }, RESET_ITEM_LABEL[k],
      door.door_type === 'NO' && k === 'release_linkage' ? el('span', { class: 'muted small' }, '（可由适配器采集）') : null, sel);
  }).filter(Boolean);
  const auto = el('input', { type: 'checkbox' });
  auto.checked = door.door_type === 'NO';
  const note = el('textarea', { rows: 2, placeholder: '测试备注（异常现象、复测建议）' });
  if (door.door_type === 'NO') {
    rows.push(el('label', { class: 'check-item full' }, auto, '复位时触发电磁释放模拟适配器，自动回填联动结果'));
  }
  const { close } = await modal({
    title: `复位测试 ${o.code} · ${o.door_code}`,
    body: el('div', {},
      el('div', { class: 'section-note' },
        `测试人：${me.name}（与维修负责人 ${o.assignee_name || ''} 非同一人）。所有适用项合格后故障方可关闭。`),
      el('div', { class: 'checklist' }, rows),
      el('label', { class: 'fld' }, '备注', note)),
    footer: [el('button', {
      class: 'btn primary', onclick: () => wrap(async () => {
        const items = {};
        for (const k of Object.keys(itemEls)) items[k] = itemEls[k].value;
        if (auto.checked) items.auto_linkage = true;
        const rt = await api(`/api/repair-orders/${o.id}/reset`, { body: { items, note: note.value } });
        close(); route();
        toast(rt.result === 'pass' ? '复位测试全部合格，门体恢复正常' : '复位测试未通过，门体退回返修', rt.result === 'pass' ? 'ok' : 'err');
      }),
    }, '提交复位结果')],
  });
}

// ---------- 复位测试记录 ----------
async function pageResets() {
  const tests = await api('/api/reset-tests');
  view.append(el('h1', { class: 'page-title' }, '复位测试'),
    el('p', { class: 'page-sub' }, '维修完工后由另一人执行；门扇 / 门框 / 闭门速度（/ 双扇顺序 / 电磁联动）逐项判定，任一不合格即退回'));
  const card = el('div', { class: 'card' });
  card.append(el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ...['测试单号', '维修单', '门体', '测试人', '时间', '结果', '测试项', ''].map(h => el('th', {}, h)))),
    el('tbody', {}, tests.map(t => {
      const items = JSON.parse(t.items);
      return el('tr', {},
        el('td', { class: 'code-link' }, t.code),
        el('td', { class: 'code-link' }, t.order_code),
        el('td', {}, el('a', { href: `#/doors/${t.door_id}` }, t.door_code)),
        el('td', {}, t.tester_name),
        el('td', { class: 'small' }, fmtDT(t.tested_at)),
        el('td', {}, badge(t.result === 'pass' ? '合格' : '退回', t.result === 'pass' ? 'normal' : 'reset_failed')),
        el('td', {}, el('span', { class: 'small' },
          Object.entries(items).filter(([, v]) => v === 'fail').map(([k]) => RESET_ITEM_LABEL[k]).join('、') ||
          (t.result === 'pass' ? '全部合格' : '—'))),
        el('td', {}, t.note ? el('span', { class: 'muted small', title: t.note }, '备注') : ''));
    }))));
  view.append(card);
}

// ---------- 逾期统计 ----------
async function pageOverdue() {
  const [{ repairs, inspections }] = await Promise.all([api('/api/overdue')]);
  view.append(el('h1', { class: 'page-title' }, '逾期统计'),
    el('p', { class: 'page-sub' }, '维修单超过时限未完工、巡检任务超过计划时间未完成均自动留痕并提醒'));
  view.append(el('div', { class: 'grid grid-2' },
    el('div', { class: 'stat red' }, el('div', { class: 'v' }, String(repairs.length)), el('div', { class: 'l' }, '逾期维修单')),
    el('div', { class: 'stat warn' }, el('div', { class: 'v' }, String(inspections.length)), el('div', { class: 'l' }, '逾期巡检任务'))));

  const rcard = el('div', { class: 'card' }, el('h2', {}, '维修超时'),
    el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ...['维修单', '门体', '负责人', '时限', '超期', '故障'].map(h => el('th', {}, h)))),
      el('tbody', {}, repairs.length ? repairs.map(r => el('tr', { class: 'overdue-row' },
        el('td', { class: 'code-link' }, r.code),
        el('td', {}, el('a', { href: `#/doors/${r.door_id}` }, r.door_code)),
        el('td', {}, r.assignee_name || '—'),
        el('td', { class: 'small' }, fmtDT(r.due_at)),
        el('td', {}, badge(`${r.overdue_hours.toFixed(1)} 小时`, 'repair_overdue')),
        el('td', {}, FAULT_KIND_LABEL[r.fault_kind] || r.fault_kind)))
        : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, '无逾期维修单'))])));

  const icard = el('div', { class: 'card' }, el('h2', {}, '巡检逾期'),
    el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ...['任务', '负责人', '应完成', '超期', '进度'].map(h => el('th', {}, h)))),
      el('tbody', {}, inspections.length ? inspections.map(i => el('tr', { class: 'overdue-row' },
        el('td', { class: 'code-link' }, el('a', { href: `#/inspections/${i.id}` }, i.code)),
        el('td', {}, i.inspector_name || '—'),
        el('td', { class: 'small' }, fmtDT(i.due_at)),
        el('td', {}, badge(`${i.overdue_hours.toFixed(1)} 小时`, 'repair_overdue')),
        el('td', {}, i.status === 'done' ? '已完成' : i.status === 'in_progress' ? '进行中' : '未开始')))
        : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, '无逾期巡检任务'))])));
  view.append(el('div', { class: 'grid grid-2' }, rcard, icard));
}

// ---------- 巡检列表 ----------
async function pageInspections() {
  const list = await api('/api/inspections');
  view.append(el('h1', { class: 'page-title' }, '路线巡检'),
    el('p', { class: 'page-sub' }, '按预定路线逐门检查门扇、门框、闭门速度、顺序关闭与释放联动；无法进入单独留痕并重排'));
  view.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary', onclick: createInspectionModal }, '＋ 新建巡检任务')));
  const card = el('div', { class: 'card' });
  card.append(el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ...['任务号', '标题', '巡检员', '计划时间', '截止时间', '进度', '状态', ''].map(h => el('th', {}, h)))),
    el('tbody', {}, list.map(i => el('tr', { class: i.overdue ? 'overdue-row' : '' },
      el('td', { class: 'code-link' }, el('a', { href: `#/inspections/${i.id}` }, i.code)),
      el('td', {}, i.title),
      el('td', {}, i.inspector_name || '—'),
      el('td', { class: 'small' }, fmtDT(i.planned_at)),
      el('td', { class: 'small' }, fmtDT(i.due_at), i.overdue ? badge('逾期', 'repair_overdue') : ''),
      el('td', {}, `${i.done_count}/${i.total_count}`),
      el('td', {}, badge({ pending: '未开始', in_progress: '进行中', done: '已完成' }[i.status],
        i.status === 'done' ? 'normal' : 'pending')),
      el('td', {}, el('a', { class: 'btn sm', href: `#/inspections/${i.id}` }, '执行')))))));
  view.append(card);
}

async function createInspectionModal() {
  if (!requireRole(['inspector', 'safety_manager', 'admin'])) return;
  const doors = await api('/api/doors');
  const me = actor();
  const zones = JSON.parse(me.zone_ids || '[]');
  const allowed = doors.filter(d => !zones.length || zones.includes(d.zone_id));
  const picks = new Map(allowed.map((d, i) => [d.id, i < 5]));
  const listBox = el('div', { style: 'max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px' },
    allowed.map((d, idx) => {
      const cb = el('input', { type: 'checkbox', checked: idx < 5 });
      cb.onchange = () => cb.checked ? picks.set(d.id, true) : picks.delete(d.id);
      return el('label', { class: 'check-item', style: 'border:none;border-bottom:1px solid var(--line);border-radius:0' },
        cb, el('span', { class: 'code-link' }, d.code), d.name,
        el('span', { class: 'muted small' }, `${d.zone_code} · ${d.door_type === 'NO' ? '常开' : '常闭'} · ${d.leaf_count === 2 ? '双扇' : '单扇'}`));
    }));
  const title = el('input', { value: `${new Date().toLocaleDateString('zh-CN')} 路线巡检` });
  const due = el('input', { type: 'number', value: '24', min: 1 });
  const { close } = await modal({
    title: '新建巡检任务（按勾选顺序生成路线）',
    body: el('div', {},
      el('div', { class: 'form-grid' },
        el('label', { class: 'fld' }, '任务标题', title),
        el('label', { class: 'fld' }, '完成时限（小时）', due)),
      el('p', { class: 'small muted' }, '勾选门体并按列表顺序巡检'),
      listBox),
    footer: [el('button', {
      class: 'btn primary', onclick: () => wrap(async () => {
        const doorIds = allowed.filter(d => picks.has(d.id)).map(d => d.id);
        const ins = await api('/api/inspections', { body: { title: title.value, doorIds, dueHours: Number(due.value) } });
        close(); location.hash = `#/inspections/${ins.id}`; toast('巡检任务已生成', 'ok');
      }),
    }, '生成任务')],
  });
}

// ---------- 巡检执行 ----------
async function pageInspection(id) {
  const ins = await api(`/api/inspections/${id}`);
  view.append(
    el('h1', { class: 'page-title' }, ins.title),
    el('p', { class: 'page-sub' }, `${ins.code} · 巡检员 ${ins.inspector_name || '—'} · 截止 ${fmtDT(ins.due_at)}`),
  );
  if (ins.status === 'pending') {
    view.append(el('div', { class: 'toolbar' },
      el('button', {
        class: 'btn primary', onclick: () => wrap(async () => { await api(`/api/inspections/${id}/start`, { body: {} }); route(); }, '已开始巡检'),
      }, '开始巡检')));
  }

  // 路线条
  const strip = el('div', { class: 'card' }, el('h2', {}, '巡检路线'),
    el('div', { class: 'route-strip' },
      ins.items.flatMap((it, idx) => {
        const node = el('div', { class: `route-node ${it.result === 'pass' ? 'done' : it.result === 'fail' ? 'fail' : it.result === 'na' ? 'na' : ''}` },
          el('div', { class: 'n' }, it.result === 'pass' ? '✓' : it.result === 'fail' ? '!' : it.result === 'na' ? '∅' : idx + 1),
          el('small', {}, it.door_code));
        const arr = idx < ins.items.length - 1 ? el('div', { class: 'route-arrow' }) : null;
        return [node, arr];
      })));
  view.append(strip);

  for (const it of ins.items) {
    const aspects = JSON.parse(it.aspects || '{}');
    const c = el('div', { class: 'card' });
    const head = el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
      el('h2', { style: 'margin:0' }, `${it.order_idx + 1}. `, el('a', { href: `#/doors/${it.door_id}` }, it.door_code), ' ', it.door_name),
      badge(it.zone_code, 'neutral'),
      badge(it.door_type === 'NO' ? '常开' : '常闭', 'neutral'),
      it.leaf_count === 2 ? badge('双扇', 'neutral') : null,
      el('span', { class: 'spacer' }),
      it.result === 'pending' ? badge('待检查', 'pending')
        : it.result === 'pass' ? badge('检查合格', 'normal')
        : it.result === 'fail' ? badge('发现故障', 'reset_failed')
        : badge('无法进入', 'partial'));
    c.append(head);
    if (it.checked_at) {
      c.append(el('p', { class: 'small muted', style: 'margin:8px 0 4px' },
        `${fmtDT(it.checked_at)} 检查${it.note ? '｜' + it.note : ''}`));
      const chips = Object.entries(aspects).filter(([k]) => ['leaf', 'frame', 'speed', 'sequence', 'linkage'].includes(k))
        .map(([k, v]) => {
          const map = { leaf: '门扇', frame: '门框', speed: '闭门速度', sequence: '双扇顺序', linkage: '释放联动' };
          return badge(`${map[k]}：${v === 'pass' ? '合格' : v === 'fail' ? '异常' : v === 'na' ? '不适用' : v}`,
            v === 'pass' ? 'normal' : v === 'fail' ? 'reset_failed' : 'neutral');
        });
      if (chips.length) c.append(el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px' }, chips));
      if (aspects.wedged) c.append(el('div', { class: 'seq-verdict bad', style: 'margin-top:8px' }, '⚠ 现场发现门体被楔开，已自动生成故障工单'));
    }
    if (it.result === 'pending') {
      c.append(el('div', { style: 'margin-top:10px' },
        el('button', { class: 'btn primary sm', onclick: () => checkItemModal(it, ins) }, '执行检查')));
    }
    view.append(c);
  }
}

async function checkItemModal(it, ins) {
  if (!requireRole(['inspector', 'safety_manager', 'admin'])) return;
  const sel = (label, key, applicable = true) => {
    if (!applicable) return null;
    const s = el('select', {},
      el('option', { value: 'pass' }, '合格'),
      el('option', { value: 'fail' }, '异常'));
    return el('div', { class: 'check-item' }, label, s);
  };
  const leaf = el('select', {}, o('合格', 'pass'), o('异常', 'fail'));
  const frame = el('select', {}, o('合格', 'pass'), o('异常', 'fail'));
  const speed = el('select', {}, o('合格', 'pass'), o('异常·过快/过慢', 'fail'));
  const sequence = it.leaf_count === 2 ? el('select', {}, o('正确(B先A后)', 'pass'), o('顺序错误', 'fail')) : null;
  const linkage = it.door_type === 'NO' ? el('select', {}, o('联动正常', 'pass'), o('联动失败', 'fail')) : null;
  const checkLinkage = el('input', { type: 'checkbox' });
  checkLinkage.checked = it.door_type === 'NO';
  const wedged = el('input', { type: 'checkbox' });
  const note = el('textarea', { rows: 2, placeholder: '现场情况说明' });
  const overall = el('select', {}, o('合格', 'pass'), o('发现故障', 'fail'), o('无法进入', 'na'));

  function o(label, value) { return el('option', { value }, label); }

  const { close } = await modal({
    title: `检查 ${it.door_code}`,
    body: el('div', {},
      el('div', { class: 'section-note' }, '逐项检查门扇、门框、闭门速度；双扇门核验顺序关闭；常开门测试电磁释放联动。'),
      el('div', { class: 'checklist' },
        el('div', { class: 'check-item' }, '门扇', leaf),
        el('div', { class: 'check-item' }, '门框', frame),
        el('div', { class: 'check-item' }, '闭门速度', speed),
        sequence ? el('div', { class: 'check-item' }, '双扇顺序', sequence) : null,
        linkage ? el('div', { class: 'check-item' }, '释放联动', linkage) : null,
        linkage ? el('label', { class: 'check-item full' }, checkLinkage, '联动失败时调用模拟适配器采集信号') : null,
        el('label', { class: 'check-item full' }, wedged, '现场发现门体被木楔/杂物楔开'),
      ),
      el('label', { class: 'fld', style: 'margin-top:8px' }, '总体结论', overall),
      el('label', { class: 'fld', style: 'margin-top:8px' }, '备注', note)),
    footer: [el('button', {
      class: 'btn primary', onclick: () => wrap(async () => {
        const aspects = {
          leaf: leaf.value, frame: frame.value, speed: speed.value,
          sequence: sequence ? sequence.value : 'na',
          linkage: linkage ? linkage.value : undefined,
          check_linkage: checkLinkage.checked,
        };
        const r = await api(`/api/inspection-items/${it.id}/check`, {
          body: { result: overall.value, aspects, wedged: wedged.checked, note: note.value },
        });
        close();
        if (r.faults?.length) toast(`已生成 ${r.faults.length} 张故障工单：${r.faults.map(f => f.code).join('、')}`, 'err');
        else toast(r.inspection.status === 'done' ? '巡检任务已全部完成' : '检查结果已记录', 'ok');
        route();
      }),
    }, '提交检查')],
  });
}

// ---------- 启动 ----------
async function boot() {
  state.users = await api('/api/users');
  await renderActor();
  window.addEventListener('hashchange', route);
  route();
}
boot();
