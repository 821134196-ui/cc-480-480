import { nextSeq, DOOR_STATUS, SEAL_STATUS, FAULT_STATUS, REPAIR_STATUS, EVENT_TYPES } from './db.js';
import { makeCode, iso, httpError, parseJson } from './util.js';

// ---------- 基础读取 ----------
export function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(id);
}

export function doorZoneId(db, doorId) {
  const d = db.prepare('SELECT zone_id FROM doors WHERE id=?').get(doorId);
  if (!d) throw httpError(404, 'door_not_found', '门体不存在');
  return d.zone_id;
}

// 区域权限：zone_ids 为空表示全域；否则门体所属分区必须在授权列表
export function assertZone(db, actor, doorId) {
  if (!actor) throw httpError(401, 'unauthorized', '缺少执行人');
  const zones = parseJson(actor.zone_ids, []);
  if (zones.length === 0) return;
  const zoneId = doorZoneId(db, doorId);
  if (!zones.includes(zoneId)) {
    throw httpError(403, 'zone_forbidden', `执行人 ${actor.name} 无该防火分区权限`);
  }
}

export function assertRole(actor, roles, msg = '无操作权限') {
  if (!actor) throw httpError(401, 'unauthorized', '缺少执行人');
  if (!roles.includes(actor.role)) throw httpError(403, 'forbidden', msg);
}

function logEvent(db, { type, doorId = null, refType = '', refId = null, actorId = null, detail = {} }) {
  return db.prepare(
    'INSERT INTO events(at,type,door_id,ref_type,ref_id,actor_id,detail) VALUES(?,?,?,?,?,?,?)'
  ).run(iso(), type, doorId, refType, refId, actorId, JSON.stringify(detail));
}

function addReminder(db, { at, type, refType = '', refId = null, message }) {
  return db.prepare(
    'INSERT INTO reminders(at,type,ref_type,ref_id,message) VALUES(?,?,?,?,?)'
  ).run(iso(at), type, refType, refId, message);
}

// 故障类别 -> 事件留痕类型
const FAULT_EVENT = {
  wedged: EVENT_TYPES.WEDGED,
  speed_fast: EVENT_TYPES.CLOSE_FAST,
  seq_error: EVENT_TYPES.SEQ_ERROR,
  no_signal: EVENT_TYPES.NO_SIGNAL,
  inaccessible: EVENT_TYPES.INACCESSIBLE,
  other: null,
};

const FAULT_TITLES = {
  wedged: '门体被楔开',
  speed_fast: '闭门速度过快',
  seq_error: '双扇顺序关闭错误',
  no_signal: '电磁释放信号无回传',
  inaccessible: '现场无法进入',
  other: '其他故障',
};

// ---------- 巡检任务 ----------
export function createInspection(db, actor, { title, doorIds = [], plannedAt = new Date(), dueHours = 24 }) {
  assertRole(actor, ['inspector', 'safety_manager', 'admin'], '仅巡检员可下发巡检任务');
  if (doorIds.length === 0) throw httpError(400, 'empty_route', '巡检路线不能为空');
  for (const id of doorIds) assertZone(db, actor, id);
  const planned = new Date(plannedAt);
  const due = new Date(planned.getTime() + dueHours * 3600_000);
  const code = makeCode('INS', nextSeq(db, 'inspection'), planned);
  const tx = db.prepare(
    'INSERT INTO inspections(code,inspector_id,title,status,planned_at,due_at) VALUES(?,?,?,?,?,?)'
  ).run(code, actor.id, title || `${fmt(planned)} 路线巡检`, 'pending', iso(planned), iso(due));
  const insId = Number(tx.lastInsertRowid);
  const item = db.prepare(
    'INSERT INTO inspection_items(inspection_id,door_id,order_idx) VALUES(?,?,?)'
  );
  doorIds.forEach((doorId, i) => item.run(insId, doorId, i));
  // 进程内提醒：到期前 1 小时 + 到期时刻
  addReminder(db, {
    at: new Date(due.getTime() - 3600_000), type: 'inspection_due',
    refType: 'inspection', refId: insId, message: `巡检任务 ${code} 将于 1 小时后到期`,
  });
  addReminder(db, {
    at: due, type: 'inspection_due',
    refType: 'inspection', refId: insId, message: `巡检任务 ${code} 已到期`,
  });
  return getInspection(db, insId);
}

export function getInspection(db, id) {
  const ins = db.prepare(`
    SELECT i.*, u.name inspector_name FROM inspections i
    LEFT JOIN users u ON u.id=i.inspector_id WHERE i.id=?`).get(id);
  if (!ins) throw httpError(404, 'inspection_not_found', '巡检任务不存在');
  ins.items = db.prepare(`
    SELECT ii.*, d.code door_code, d.name door_name, d.door_type, d.leaf_count,
           z.code zone_code, z.name zone_name
    FROM inspection_items ii
    JOIN doors d ON d.id=ii.door_id
    JOIN zones z ON z.id=d.zone_id
    WHERE ii.inspection_id=? ORDER BY ii.order_idx`).all(id);
  return ins;
}

export function startInspection(db, actor, id) {
  const ins = getInspection(db, id);
  if (ins.inspector_id !== actor.id && actor.role === 'inspector') {
    throw httpError(403, 'forbidden', '只能开始自己的巡检任务');
  }
  if (ins.status === 'pending') {
    db.prepare("UPDATE inspections SET status='in_progress', started_at=? WHERE id=?")
      .run(iso(), id);
  }
  return getInspection(db, id);
}

// 记录单个门体检查结果；发现故障自动开工单（按类别去重）
export function checkInspectionItem(db, actor, itemId, { result, aspects = {}, wedged = false, note = '', emAdapter = null }) {
  const item = db.prepare('SELECT * FROM inspection_items WHERE id=?').get(itemId);
  if (!item) throw httpError(404, 'item_not_found', '巡检项不存在');
  assertZone(db, actor, item.door_id);
  if (result === 'na') {
    // 现场无法进入：留痕 + 重检提醒，不开故障单
    db.prepare("UPDATE inspection_items SET result='na', aspects=?, checked_at=?, checked_by=?, note=? WHERE id=?")
      .run(JSON.stringify({ inaccessible: true }), iso(), actor.id, note, itemId);
    logEvent(db, { type: EVENT_TYPES.INACCESSIBLE, doorId: item.door_id,
      refType: 'inspection_item', refId: itemId, actorId: actor.id, detail: { note } });
    addReminder(db, { at: new Date(Date.now() + 4 * 3600_000), type: 'inspection_due',
      refType: 'door', refId: item.door_id, message: `门体 ${item.door_id} 此前无法进入，安排重检` });
    return getInspection(db, item.inspection_id);
  }
  if (result !== 'pass' && result !== 'fail') throw httpError(400, 'bad_result', '结果须为 pass/fail/na');

  const door = db.prepare('SELECT * FROM doors WHERE id=?').get(item.door_id);
  if (door.decommissioned) throw httpError(409, 'decommissioned', '停用门体不参与巡检');

  // 联动失败：以模拟适配器回传为准（aspects.linkage==='fail' 时亦记录）
  let linkage = aspects.linkage || null;
  if (door.door_type === 'NO' && result === 'fail' && aspects.check_linkage && emAdapter) {
    const sig = emAdapter.triggerRelease(door.code);
    linkage = sig.ok ? 'pass' : 'fail';
    aspects.linkage_signal = sig;
  }

  const aspectJson = JSON.stringify({ ...aspects, wedged });
  db.prepare("UPDATE inspection_items SET result=?, aspects=?, checked_at=?, checked_by=?, note=? WHERE id=?")
    .run(result, aspectJson, iso(), actor.id, note, itemId);

  const faults = [];
  if (result === 'fail') {
    if (wedged) faults.push(reportFault(db, actor, item.door_id, 'wedged', { inspectionItemId: item.id, detail: { note } }));
    if (aspects.speed === 'fail') faults.push(reportFault(db, actor, item.door_id, 'speed_fast', { inspectionItemId: item.id }));
    if (aspects.sequence === 'fail') faults.push(reportFault(db, actor, item.door_id, 'seq_error', { inspectionItemId: item.id }));
    if (linkage === 'fail') faults.push(reportFault(db, actor, item.door_id, 'no_signal', { inspectionItemId: item.id, detail: { signal: aspects.linkage_signal || null } }));
    if (aspects.leaf === 'fail' || aspects.frame === 'fail') {
      faults.push(reportFault(db, actor, item.door_id, 'other', {
        inspectionItemId: item.id,
        title: [aspects.leaf === 'fail' ? '门扇缺陷' : null, aspects.frame === 'fail' ? '门框缺陷' : null].filter(Boolean).join('、'),
      }));
    }
  }
  // 全部项处理完则完成巡检
  const pending = db.prepare("SELECT COUNT(*) c FROM inspection_items WHERE inspection_id=? AND result='pending'")
    .get(item.inspection_id).c;
  if (pending === 0) {
    db.prepare("UPDATE inspections SET status='done', finished_at=? WHERE id=?").run(iso(), item.inspection_id);
  } else if (db.prepare("SELECT status FROM inspections WHERE id=?").get(item.inspection_id).status === 'pending') {
    db.prepare("UPDATE inspections SET status='in_progress', started_at=COALESCE(started_at,?) WHERE id=?").run(iso(), item.inspection_id);
  }
  return { inspection: getInspection(db, item.inspection_id), faults };
}

// ---------- 故障工单 ----------
export function reportFault(db, actor, doorId, kind, { inspectionItemId = null, detail = {}, title = '' } = {}) {
  assertZone(db, actor, doorId);
  const door = db.prepare('SELECT * FROM doors WHERE id=?').get(doorId);
  if (door.decommissioned) throw httpError(409, 'decommissioned', '停用门体不可上报故障');
  if (!FAULT_TITLES[kind]) throw httpError(400, 'bad_kind', '未知故障类别');
  if ([DOOR_STATUS.REPAIRING, DOOR_STATUS.AWAIT_RESET].includes(door.status)) {
    throw httpError(409, 'door_busy', `门体当前为「${door.status}」，不可重复上报，待维修/复位结束后再报`);
  }
  // 同类别未关闭故障不重复开单（工单唯一）
  const dup = db.prepare(`
    SELECT * FROM faults WHERE door_id=? AND kind=? AND status!='closed'`).get(doorId, kind);
  if (dup) return dup;

  const code = makeCode('FLT', nextSeq(db, 'fault'));
  const tx = db.prepare(`
    INSERT INTO faults(code,door_id,inspection_item_id,kind,title,detail,reporter_id,reported_at,status)
    VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(code, doorId, inspectionItemId, kind, title || FAULT_TITLES[kind],
    JSON.stringify(detail), actor.id, iso(), FAULT_STATUS.OPEN);
  const faultId = Number(tx.lastInsertRowid);
  if (door.status === DOOR_STATUS.NORMAL) {
    db.prepare("UPDATE doors SET status='pending_repair' WHERE id=?").run(doorId);
  }
  const ev = FAULT_EVENT[kind];
  if (ev) logEvent(db, { type: ev, doorId, refType: 'fault', refId: faultId, actorId: actor.id, detail });
  return db.prepare('SELECT * FROM faults WHERE id=?').get(faultId);
}

// ---------- 维修单 ----------
export function createRepairOrder(db, actor, faultId, { dueHours = 24 } = {}) {
  assertRole(actor, ['repair', 'admin'], '仅维修人员可接单');
  const fault = db.prepare('SELECT * FROM faults WHERE id=?').get(faultId);
  if (!fault) throw httpError(404, 'fault_not_found', '故障单不存在');
  if (fault.status === FAULT_STATUS.CLOSED) throw httpError(409, 'fault_closed', '故障已关闭，不可再开维修单');
  assertZone(db, actor, fault.door_id);

  const code = makeCode('RPO', nextSeq(db, 'repair'));
  const nowIso = iso();
  const due = new Date(Date.now() + dueHours * 3600_000);
  let info;
  try {
    info = db.prepare(`
      INSERT INTO repair_orders(code,fault_id,door_id,assignee_id,status,created_at,due_at)
      VALUES(?,?,?,?, 'open', ?, ?)`)
      .run(code, faultId, fault.door_id, actor.id, nowIso, iso(due));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      throw httpError(409, 'door_occupied', '该门体已有进行中的维修单，不能同时占用');
    }
    throw e;
  }
  const orderId = Number(info.lastInsertRowid);
  db.prepare("UPDATE faults SET status='repairing' WHERE id=?").run(faultId);
  db.prepare("UPDATE doors SET status='repairing' WHERE id=?").run(fault.door_id);
  addReminder(db, { at: due, type: 'repair_overdue', refType: 'repair_order', refId: orderId,
    message: `维修单 ${code} 已超过 ${dueHours} 小时时限` });
  return db.prepare('SELECT * FROM repair_orders WHERE id=?').get(orderId);
}

export function startRepair(db, actor, orderId) {
  const order = db.prepare('SELECT * FROM repair_orders WHERE id=?').get(orderId);
  if (!order) throw httpError(404, 'order_not_found', '维修单不存在');
  assertZone(db, actor, order.door_id);
  if (order.assignee_id !== actor.id && actor.role !== 'admin') {
    throw httpError(403, 'forbidden', '只有该维修单负责人可以开工');
  }
  if (order.status === 'open') {
    db.prepare("UPDATE repair_orders SET status='in_progress', started_at=? WHERE id=?").run(iso(), orderId);
  }
  return db.prepare('SELECT * FROM repair_orders WHERE id=?').get(orderId);
}

// 维修完成：门体进入待复位，绝不直接恢复正常
export function completeRepair(db, actor, orderId, { workNote = '' } = {}) {
  const order = db.prepare('SELECT * FROM repair_orders WHERE id=?').get(orderId);
  if (!order) throw httpError(404, 'order_not_found', '维修单不存在');
  assertZone(db, actor, order.door_id);
  if (order.assignee_id !== actor.id && actor.role !== 'admin') {
    throw httpError(403, 'forbidden', '只有维修单负责人可以填报完工');
  }
  if (!['open', 'in_progress'].includes(order.status)) {
    throw httpError(409, 'order_not_active', '维修单不在进行中，不能完工');
  }
  db.prepare("UPDATE repair_orders SET status='done', finished_at=?, work_note=? WHERE id=?")
    .run(iso(), workNote, orderId);
  db.prepare("UPDATE faults SET status='await_reset' WHERE id=?").run(order.fault_id);
  // 临时封控仍在时门体保持封控，否则进入待复位
  const blocked = db.prepare("SELECT COUNT(*) c FROM temp_measures WHERE door_id=? AND status='active'").get(order.door_id).c;
  db.prepare('UPDATE doors SET status=? WHERE id=?')
    .run(blocked ? DOOR_STATUS.TEMP_BLOCKED : DOOR_STATUS.AWAIT_RESET, order.door_id);
  logEvent(db, { type: EVENT_TYPES.REPAIR_DONE, doorId: order.door_id,
    refType: 'repair_order', refId: orderId, actorId: actor.id, detail: { work_note: workNote } });
  return db.prepare('SELECT * FROM repair_orders WHERE id=?').get(orderId);
}

// ---------- 复位测试 ----------
// 适用测试项：双扇门查顺序；常开门查电磁释放联动
export function applicableResetItems(door) {
  return {
    door_leaf: true,
    frame: true,
    close_speed: true,
    sequence: door.leaf_count === 2,
    release_linkage: door.door_type === 'NO',
  };
}

export function createResetTest(db, actor, orderId, { items = {}, note = '', closeTests = [], emAdapter = null, signalLog = null }) {
  const order = db.prepare('SELECT * FROM repair_orders WHERE id=?').get(orderId);
  if (!order) throw httpError(404, 'order_not_found', '维修单不存在');
  // 职责分离：维修人不能测试自己的维修单（最先校验，错误明确）
  if (actor && order.assignee_id === actor.id) {
    throw httpError(403, 'self_reset', '维修人不能对自己的维修单执行复位测试，须由另一人执行');
  }
  assertRole(actor, ['inspector', 'safety_manager', 'admin'], '复位测试须由巡检员或安全主管执行');
  if (order.status !== 'done') throw httpError(409, 'order_not_done', '维修单未完工，不能复位测试');
  assertZone(db, actor, order.door_id);

  const fault = db.prepare('SELECT * FROM faults WHERE id=?').get(order.fault_id);
  if (fault.status === FAULT_STATUS.CLOSED) {
    throw httpError(409, 'fault_already_closed', '同一故障不能重复关闭，复位测试已完成');
  }
  const door = db.prepare('SELECT * FROM doors WHERE id=?').get(order.door_id);
  if (door.decommissioned) throw httpError(409, 'decommissioned', '停用门体不可复位');

  // 常开门复位时自动触发模拟适配器采集释放联动信号
  if (door.door_type === 'NO' && emAdapter && (items.auto_linkage || !items.release_linkage)) {
    const sig = emAdapter.triggerRelease(door.code);
    items.release_linkage = sig.ok ? 'pass' : 'fail';
    if (signalLog) signalLog.push(sig);
    note = note ? `${note}｜联动信号：${sig.message}` : `联动信号：${sig.message}`;
  }

  const apply = applicableResetItems(door);
  const normalized = {};
  for (const [k, required] of Object.entries(apply)) {
    if (!required) { normalized[k] = 'na'; continue; }
    const v = items[k];
    if (v !== 'pass' && v !== 'fail') throw httpError(400, 'missing_item', `复位测试项不完整：${k}`);
    normalized[k] = v;
  }
  const allPass = Object.entries(normalized).every(([, v]) => v === 'pass' || v === 'na');
  const result = allPass ? 'pass' : 'fail';
  const code = makeCode('RST', nextSeq(db, 'reset'));
  const tx = db.prepare(`
    INSERT INTO reset_tests(code,repair_order_id,fault_id,door_id,tester_id,tested_at,result,items,note)
    VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(code, orderId, fault.id, door.id, actor.id, iso(), result, JSON.stringify(normalized), note);
  const testId = Number(tx.lastInsertRowid);

  for (const ct of closeTests) saveCloseTest(db, door.id, { ...ct, refType: 'reset', at: new Date() });

  if (result === 'pass') {
    db.prepare("UPDATE faults SET status='closed', closed_at=?, close_note=? WHERE id=?")
      .run(iso(), `复位测试 ${code} 合格`, fault.id);
    const stillOpen = db.prepare("SELECT COUNT(*) c FROM faults WHERE door_id=? AND status!='closed'").get(door.id).c;
    if (stillOpen === 0) db.prepare("UPDATE doors SET status='normal' WHERE id=?").run(door.id);
    // 合格后自动解除仍生效的临时措施
    const acts = db.prepare("SELECT * FROM temp_measures WHERE door_id=? AND status='active'").all(door.id);
    for (const m of acts) {
      db.prepare("UPDATE temp_measures SET status='revoked', revoked_at=?, revoke_note=? WHERE id=?")
        .run(iso(), `复位测试 ${code} 合格，自动解除`, m.id);
    }
    logEvent(db, { type: EVENT_TYPES.RESET_PASS, doorId: door.id,
      refType: 'reset_test', refId: testId, actorId: actor.id, detail: { items: normalized } });
  } else {
    db.prepare("UPDATE faults SET status='reset_failed' WHERE id=?").run(fault.id);
    db.prepare("UPDATE doors SET status='reset_failed' WHERE id=?").run(door.id);
    db.prepare('UPDATE repair_orders SET reset_failure_count=reset_failure_count+1 WHERE id=?').run(orderId);
    logEvent(db, { type: EVENT_TYPES.RESET_FAIL, doorId: door.id,
      refType: 'reset_test', refId: testId, actorId: actor.id, detail: { items: normalized, note } });
  }
  return db.prepare(`
    SELECT rt.*, u.name tester_name FROM reset_tests rt
    JOIN users u ON u.id=rt.tester_id WHERE rt.id=?`).get(testId);
}

// ---------- 闭门测试（时间刻度） ----------
export function saveCloseTest(db, doorId, { leaf = 'A', openAngle = 90, startMoveMs, latchMs, closedMs, refType = 'manual', at = new Date() }) {
  // 过快：<2000ms 完全关闭；过慢/无法闭合：>30s 或缺失
  let result = 'pass';
  if (closedMs == null || closedMs > 30000 || startMoveMs == null) result = 'fail';
  else if (closedMs < 2000) result = 'fail';
  const tx = db.prepare(`
    INSERT INTO close_tests(door_id,at,ref_type,leaf,open_angle,start_move_ms,latch_ms,closed_ms,result)
    VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(doorId, iso(at), refType, leaf, openAngle, startMoveMs, latchMs, closedMs, result);
  return db.prepare('SELECT * FROM close_tests WHERE id=?').get(Number(tx.lastInsertRowid));
}

// 双扇顺序判定：B 扇（后扇）应先于 A 扇进入锁口
export function evaluateSequence(tests) {
  const latch = t => (t.latchMs ?? t.latch_ms ?? null);
  const a = tests.find(t => t.leaf === 'A');
  const b = tests.find(t => t.leaf === 'B');
  if (!a || !b || latch(a) == null || latch(b) == null) return { ok: null, detail: '数据不完整' };
  const ok = latch(b) < latch(a);
  return { ok, detail: ok ? `B 扇 ${latch(b)}ms 先闭合，A 扇 ${latch(a)}ms 后闭合`
    : `A 扇 ${latch(a)}ms 先于 B 扇 ${latch(b)}ms 闭合，顺序错误` };
}

// ---------- 临时措施（仅安全主管） ----------
export function approveTempMeasure(db, actor, doorId, { reason = '', expireHours = 24, faultId = null }) {
  assertRole(actor, ['safety_manager', 'admin'], '仅安全主管可批准临时措施');
  assertZone(db, actor, doorId);
  const door = db.prepare('SELECT * FROM doors WHERE id=?').get(doorId);
  if (door.decommissioned) throw httpError(409, 'decommissioned', '停用门体不可批准临时措施');
  const exists = db.prepare("SELECT COUNT(*) c FROM temp_measures WHERE door_id=? AND status='active'").get(doorId).c;
  if (exists) throw httpError(409, 'measure_exists', '该门体已有生效中的临时措施');
  const expire = new Date(Date.now() + expireHours * 3600_000);
  const tx = db.prepare(`
    INSERT INTO temp_measures(door_id,fault_id,reason,approved_by,approved_at,expire_at,status)
    VALUES(?,?,?,?,?,?,'active')`
  ).run(doorId, faultId, reason, actor.id, iso(), iso(expire));
  const id = Number(tx.lastInsertRowid);
  db.prepare("UPDATE doors SET status='temp_blocked' WHERE id=?").run(doorId);
  if (faultId) db.prepare("UPDATE faults SET status='temp_blocked' WHERE id=? AND status IN ('open','reset_failed')").run(faultId);
  addReminder(db, { at: expire, type: 'temp_expired', refType: 'temp_measure', refId: id,
    message: `门体 ${door.code} 的临时措施到期` });
  logEvent(db, { type: EVENT_TYPES.TEMP_APPROVED, doorId, refType: 'temp_measure', refId: id,
    actorId: actor.id, detail: { reason, expire_at: iso(expire) } });
  return db.prepare('SELECT * FROM temp_measures WHERE id=?').get(id);
}

export function revokeTempMeasure(db, actor, id, { note = '' } = {}) {
  const m = db.prepare('SELECT * FROM temp_measures WHERE id=?').get(id);
  if (!m) throw httpError(404, 'measure_not_found', '临时措施不存在');
  assertRole(actor, ['safety_manager', 'admin'], '仅安全主管可解除临时措施');
  assertZone(db, actor, m.door_id);
  if (m.status !== 'active') throw httpError(409, 'measure_not_active', '临时措施已不在生效中');
  db.prepare("UPDATE temp_measures SET status='revoked', revoked_at=?, revoke_note=? WHERE id=?")
    .run(iso(), note, id);
  // 门体回到其应有状态
  const openFault = db.prepare("SELECT COUNT(*) c FROM faults WHERE door_id=? AND status!='closed'").get(m.door_id).c;
  db.prepare('UPDATE doors SET status=? WHERE id=?')
    .run(openFault ? DOOR_STATUS.PENDING_REPAIR : DOOR_STATUS.NORMAL, m.door_id);
  return db.prepare('SELECT * FROM temp_measures WHERE id=?').get(id);
}

// 调度器调用：临时措施到期
export function expireTempMeasure(db, id) {
  const m = db.prepare('SELECT * FROM temp_measures WHERE id=?').get(id);
  if (!m || m.status !== 'active') return null;
  db.prepare("UPDATE temp_measures SET status='expired' WHERE id=?").run(id);
  const door = db.prepare('SELECT * FROM doors WHERE id=?').get(m.door_id);
  if (door.status === DOOR_STATUS.TEMP_BLOCKED) {
    db.prepare("UPDATE doors SET status='pending_repair' WHERE id=?").run(m.door_id);
  }
  db.prepare("UPDATE faults SET status='open' WHERE door_id=? AND status='temp_blocked'").run(m.door_id);
  logEvent(db, { type: EVENT_TYPES.TEMP_EXPIRED, doorId: m.door_id, refType: 'temp_measure', refId: id,
    detail: { reason: m.reason } });
  return db.prepare('SELECT * FROM temp_measures WHERE id=?').get(id);
}

// ---------- 停用 / 恢复 ----------
export function setDecommissioned(db, actor, doorId, { active, reason = '', seal = null }) {
  assertRole(actor, ['safety_manager', 'admin'], '仅安全主管可停用/恢复门体');
  assertZone(db, actor, doorId);
  const occupied = db.prepare("SELECT COUNT(*) c FROM repair_orders WHERE door_id=? AND status IN ('open','in_progress')").get(doorId).c;
  if (active && occupied) throw httpError(409, 'door_occupied', '门体有进行中维修单，不可停用');
  db.prepare('UPDATE doors SET decommissioned=?, status=? WHERE id=?')
    .run(active ? 1 : 0, active ? DOOR_STATUS.DECOMMISSIONED : DOOR_STATUS.NORMAL, doorId);
  if (seal && Object.values(SEAL_STATUS).includes(seal)) {
    db.prepare('UPDATE doors SET seal_status=? WHERE id=?').run(active ? seal : 'none', doorId);
  }
  logEvent(db, {
    type: active ? EVENT_TYPES.DECOMMISSION : EVENT_TYPES.REACTIVATE,
    doorId, actorId: actor.id, detail: { reason },
  });
  return db.prepare('SELECT * FROM doors WHERE id=?').get(doorId);
}

// ---------- 逾期判定 ----------
export function overdueRepairs(db) {
  return db.prepare(`
    SELECT ro.*, f.kind fault_kind, d.code door_code, u.name assignee_name,
      CAST((julianday('now') - julianday(ro.due_at)) * 24 AS REAL) AS overdue_hours
    FROM repair_orders ro
    JOIN faults f ON f.id=ro.fault_id
    JOIN doors d ON d.id=ro.door_id
    LEFT JOIN users u ON u.id=ro.assignee_id
    WHERE ro.status IN ('open','in_progress') AND julianday(ro.due_at) < julianday('now')
    ORDER BY ro.due_at`).all();
}

export function overdueInspections(db) {
  return db.prepare(`
    SELECT i.*, u.name inspector_name,
      CAST((julianday('now') - julianday(i.due_at)) * 24 AS REAL) AS overdue_hours
    FROM inspections i LEFT JOIN users u ON u.id=i.inspector_id
    WHERE i.status!='done' AND julianday(i.due_at) < julianday('now')
    ORDER BY i.due_at`).all();
}

// 维修超时留痕（去重：每条维修单自开工后仅记一次）
export function markRepairOverdue(db, orderId) {
  const order = db.prepare('SELECT * FROM repair_orders WHERE id=?').get(orderId);
  if (!order || !['open', 'in_progress'].includes(order.status)) return null;
  const already = db.prepare(`
    SELECT COUNT(*) c FROM events
    WHERE type='repair_overdue' AND ref_type='repair_order' AND ref_id=?`).get(orderId).c;
  if (already) return null;
  logEvent(db, { type: EVENT_TYPES.REPAIR_OVERDUE, doorId: order.door_id,
    refType: 'repair_order', refId: orderId, detail: { due_at: order.due_at } });
  return true;
}

function fmt(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
