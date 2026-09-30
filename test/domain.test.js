import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, DOOR_STATUS, FAULT_STATUS } from '../src/db.js';
import {
  createInspection, checkInspectionItem, reportFault, createRepairOrder,
  startRepair, completeRepair, createResetTest, approveTempMeasure,
  revokeTempMeasure, expireTempMeasure, setDecommissioned,
  applicableResetItems, saveCloseTest, evaluateSequence,
  overdueRepairs,
} from '../src/services.js';
import { EMReleaseAdapter, configureRelease, resetReleaseScripts } from '../src/adapter.js';

function makeWorld() {
  const db = openDb(':memory:');
  const uid = (name, role, zones = []) => Number(db.prepare(
    "INSERT INTO users(name,role,zone_ids) VALUES(?,?,?)").run(name, role, JSON.stringify(zones)).lastInsertRowid);
  const mId = uid('主管', 'safety_manager');
  const iId = uid('巡检甲', 'inspector');
  const iZId = uid('巡检乙', 'inspector');          // 仅 Z1
  const rId = uid('维修甲', 'repair');
  const rZId = uid('维修乙', 'repair');             // 仅 Z2
  const b = Number(db.prepare("INSERT INTO buildings(name) VALUES('B')").run().lastInsertRowid);
  const zId = Number(db.prepare("INSERT INTO zones(building_id,code,name,px,py,pw,ph) VALUES(?,?,?,60,60,300,180)").run(b, 'Z1', '一分区').lastInsertRowid);
  const z2Id = Number(db.prepare("INSERT INTO zones(building_id,code,name,px,py,pw,ph) VALUES(?,?,?,60,60,300,180)").run(b, 'Z2', '二分区').lastInsertRowid);
  db.prepare('UPDATE users SET zone_ids=? WHERE id=?').run(JSON.stringify([zId]), iZId);
  db.prepare('UPDATE users SET zone_ids=? WHERE id=?').run(JSON.stringify([z2Id]), rZId);

  const door = (code, type = 'NC', leaves = 1, zone = zId) => Number(db.prepare(
    "INSERT INTO doors(zone_id,code,door_type,leaf_count,gx,gy) VALUES(?,?,?,?,100,100)")
    .run(zone, code, type, leaves).lastInsertRowid);
  const addComp = (d, type) => {
    db.prepare("INSERT INTO components(door_id,kind) VALUES(?,?)").run(d, type);
  };
  const d1 = door('FM-1', 'NC', 1); addComp(d1, 'closer');
  const d2 = door('FM-2', 'NC', 2); addComp(d2, 'closer'); addComp(d2, 'sequencer');
  const d3 = door('FM-3', 'NO', 2); addComp(d3, 'closer'); addComp(d3, 'sequencer'); addComp(d3, 'em_release');

  const act = (id) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    return { ...u, zone_ids: u.zone_ids };
  };
  return { db, users: { manager: act(mId), inspector: act(iId), inspectorZ: act(iZId), repair: act(rId), repairZ: act(rZId) }, doors: { d1, d2, d3 }, zones: { z1: zId, z2: z2Id } };
}

let w;
beforeEach(() => { w = makeWorld(); resetReleaseScripts(); });

test('巡检发现楔开故障：自动开单、门体进入待维修、事件留痕', () => {
  const { db, users, doors } = w;
  const ins = createInspection(db, users.inspector, { title: 't', doorIds: [doors.d1] });
  const itemId = ins.items[0].id;
  const { faults } = checkInspectionItem(db, users.inspector, itemId, {
    result: 'fail', aspects: { leaf: 'pass', frame: 'pass', speed: 'pass' }, wedged: true,
  });
  assert.equal(faults.length, 1);
  assert.equal(faults[0].kind, 'wedged');
  const door = db.prepare('SELECT * FROM doors WHERE id=?').get(doors.d1);
  assert.equal(door.status, DOOR_STATUS.PENDING_REPAIR);
  const ev = db.prepare("SELECT * FROM events WHERE type='wedged'").all();
  assert.equal(ev.length, 1);
});

test('工单唯一：同类别未关闭故障不重复开单', () => {
  const { db, users, doors } = w;
  const f1 = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  const f2 = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  assert.equal(f1.id, f2.id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM faults').get().c, 1);
});

test('维修流程完整：完工后进入待复位，不能直接恢复正常', () => {
  const { db, users, doors } = w;
  const f = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  const o = createRepairOrder(db, users.repair, f.id);
  startRepair(db, users.repair, o.id);
  completeRepair(db, users.repair, o.id, { workNote: '调阻尼' });
  const door = db.prepare('SELECT * FROM doors WHERE id=?').get(doors.d1);
  assert.equal(door.status, DOOR_STATUS.AWAIT_RESET);
  assert.equal(db.prepare('SELECT status FROM faults WHERE id=?').get(f.id).status, FAULT_STATUS.AWAIT_RESET);
});

test('两个维修单不能同时占用同一门体', () => {
  const { db, users, doors } = w;
  const f1 = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  createRepairOrder(db, users.repair, f1.id);
  // 门体维修中时第二张单必须被拒（无论是新故障还是手工插单）
  const f2Id = Number(db.prepare(
    "INSERT INTO faults(code,door_id,kind,title,reporter_id,reported_at,status) VALUES('FLT-X',?,'wedged','x',?,datetime('now'),'open')")
    .run(doors.d1, users.inspector.id).lastInsertRowid);
  assert.throws(() => createRepairOrder(db, users.repair, f2Id), (e) => e.code === 'door_occupied');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM repair_orders WHERE status IN ('open','in_progress')").get().c, 1);
});

test('职责分离：维修人不能对自己的维修单执行复位测试', () => {
  const { db, users, doors } = w;
  const f = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  const o = createRepairOrder(db, users.repair, f.id);
  completeRepair(db, users.repair, o.id);
  assert.throws(() => createResetTest(db, users.repair, o.id, {
    items: { door_leaf: 'pass', frame: 'pass', close_speed: 'pass' },
  }), (e) => e.code === 'self_reset');
});

test('步骤完整：复位测试项缺失被拒绝', () => {
  const { db, users, doors } = w;
  const f = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  const o = createRepairOrder(db, users.repair, f.id);
  completeRepair(db, users.repair, o.id);
  assert.throws(() => createResetTest(db, users.inspector, o.id, {
    items: { door_leaf: 'pass' }, // 缺 frame/close_speed
  }), (e) => e.code === 'missing_item');
});

test('双扇常开门复位项包含顺序与联动', () => {
  const door = { leaf_count: 2, door_type: 'NO' };
  assert.deepEqual(applicableResetItems(door), {
    door_leaf: true, frame: true, close_speed: true, sequence: true, release_linkage: true,
  });
});

test('复位退回：任一项不合格则门体 reset_failed、故障不关闭，并留痕', () => {
  const { db, users, doors } = w;
  const f = reportFault(db, users.inspector, doors.d2, 'seq_error');
  const o = createRepairOrder(db, users.repair, f.id);
  completeRepair(db, users.repair, o.id);
  const rt = createResetTest(db, users.inspector, o.id, {
    items: { door_leaf: 'pass', frame: 'pass', close_speed: 'pass', sequence: 'fail' },
    note: 'B 扇仍晚于 A 扇',
  });
  assert.equal(rt.result, 'fail');
  assert.equal(db.prepare('SELECT status FROM doors WHERE id=?').get(doors.d2).status, DOOR_STATUS.RESET_FAILED);
  assert.equal(db.prepare('SELECT status FROM faults WHERE id=?').get(f.id).status, FAULT_STATUS.RESET_FAILED);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE type='reset_fail'").get().c, 1);
});

test('复位合格：故障关闭且门体恢复正常', () => {
  const { db, users, doors } = w;
  const f = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  const o = createRepairOrder(db, users.repair, f.id);
  completeRepair(db, users.repair, o.id);
  createResetTest(db, users.inspector, o.id, {
    items: { door_leaf: 'pass', frame: 'pass', close_speed: 'pass' },
  });
  assert.equal(db.prepare('SELECT status FROM doors WHERE id=?').get(doors.d1).status, DOOR_STATUS.NORMAL);
  assert.equal(db.prepare('SELECT status FROM faults WHERE id=?').get(f.id).status, FAULT_STATUS.CLOSED);
});

test('同一故障不能重复关闭：合格复位后再次测试被拒', () => {
  const { db, users, doors } = w;
  const f = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  const o = createRepairOrder(db, users.repair, f.id);
  completeRepair(db, users.repair, o.id);
  createResetTest(db, users.inspector, o.id, {
    items: { door_leaf: 'pass', frame: 'pass', close_speed: 'pass' },
  });
  assert.throws(() => createResetTest(db, users.inspector, o.id, {
    items: { door_leaf: 'pass', frame: 'pass', close_speed: 'pass' },
  }), (e) => e.code === 'fault_already_closed');
});

test('电磁释放模拟适配器：无回传判联动失败，适配器恢复后复测合格', () => {
  const { db, users, doors } = w;
  configureRelease('FM-3', 'no_feedback');
  const adapter = new EMReleaseAdapter();
  const f = reportFault(db, users.inspector, doors.d3, 'no_signal');
  const o = createRepairOrder(db, users.repair, f.id);
  completeRepair(db, users.repair, o.id);
  const rt1 = createResetTest(db, users.inspector, o.id, {
    items: { door_leaf: 'pass', frame: 'pass', close_speed: 'pass', sequence: 'pass', auto_linkage: true },
    emAdapter: adapter,
  });
  assert.equal(rt1.result, 'fail');
  assert.equal(db.prepare('SELECT status FROM doors WHERE id=?').get(doors.d3).status, DOOR_STATUS.RESET_FAILED);

  // 维修后适配器恢复：新建维修单并复测
  resetReleaseScripts();
  const o2 = createRepairOrder(db, users.repair, f.id);
  completeRepair(db, users.repair, o2.id);
  const rt2 = createResetTest(db, users.inspector, o2.id, {
    items: { door_leaf: 'pass', frame: 'pass', close_speed: 'pass', sequence: 'pass', auto_linkage: true },
    emAdapter: adapter,
  });
  assert.equal(rt2.result, 'pass');
});

test('临时措施仅安全主管可批准；到期自动失效并留痕', () => {
  const { db, users, doors } = w;
  assert.throws(() => approveTempMeasure(db, users.inspector, doors.d1, { expireHours: 1 }), (e) => e.code === 'forbidden');
  const m = approveTempMeasure(db, users.manager, doors.d1, { reason: '封控', expireHours: 24 });
  assert.equal(db.prepare('SELECT status FROM doors WHERE id=?').get(doors.d1).status, DOOR_STATUS.TEMP_BLOCKED);
  const expired = expireTempMeasure(db, m.id);
  assert.equal(expired.status, 'expired');
  assert.equal(db.prepare('SELECT status FROM doors WHERE id=?').get(doors.d1).status, DOOR_STATUS.PENDING_REPAIR);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE type='temp_expired'").get().c, 1);
});

test('临时措施未到期保持封控；手动解除后回待维修', () => {
  const { db, users, doors } = w;
  reportFault(db, users.inspector, doors.d1, 'wedged');
  const m = approveTempMeasure(db, users.manager, doors.d1, { reason: 'r', expireHours: 24 });
  assert.equal(expireTempMeasure(db, 9999), null);
  revokeTempMeasure(db, users.manager, m.id);
  assert.equal(db.prepare('SELECT status FROM doors WHERE id=?').get(doors.d1).status, DOOR_STATUS.PENDING_REPAIR);
});

test('临时措施与复位联动：合格复位自动解除封控', () => {
  const { db, users, doors } = w;
  const f = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  approveTempMeasure(db, users.manager, doors.d1, { reason: '封控中维修', expireHours: 24, faultId: f.id });
  const o = createRepairOrder(db, users.repair, f.id);
  completeRepair(db, users.repair, o.id);
  // 完工时仍封控
  assert.equal(db.prepare('SELECT status FROM doors WHERE id=?').get(doors.d1).status, DOOR_STATUS.TEMP_BLOCKED);
  createResetTest(db, users.inspector, o.id, {
    items: { door_leaf: 'pass', frame: 'pass', close_speed: 'pass' },
  });
  assert.equal(db.prepare('SELECT status FROM doors WHERE id=?').get(doors.d1).status, DOOR_STATUS.NORMAL);
  assert.equal(db.prepare("SELECT status FROM temp_measures WHERE door_id=?").get(doors.d1).status, 'revoked');
});

test('区域权限：越区巡检/维修/批准被拒', () => {
  const { db, users, doors } = w;
  // 巡检乙仅有 Z1 权限，d3 在 Z1 内可用，构造 Z2 门体越权
  const dZ2 = Number(db.prepare("INSERT INTO doors(zone_id,code,door_type,leaf_count,gx,gy) VALUES(?,?, 'NC',1,1,1)")
    .run(w.zones.z2, 'FM-Z2').lastInsertRowid);
  assert.throws(() => reportFault(db, users.inspectorZ, dZ2, 'wedged'), (e) => e.code === 'zone_forbidden');
  const f = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  assert.throws(() => createRepairOrder(db, users.repairZ, f.id), (e) => e.code === 'zone_forbidden');
  assert.throws(() => approveTempMeasure(db, users.inspector, doors.d1, {}), (e) => e.code === 'forbidden');
});

test('无法进入：留痕且不开故障单，产生重检提醒', () => {
  const { db, users, doors } = w;
  const ins = createInspection(db, users.inspector, { doorIds: [doors.d1] });
  checkInspectionItem(db, users.inspector, ins.items[0].id, { result: 'na', note: '锁闭' });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE type='inaccessible'").get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM faults').get().c, 0);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM reminders WHERE type='inspection_due'").get().c >= 1);
});

test('闭门测试时间刻度：过快/正常判定；双扇顺序 B 先于 A', () => {
  const { db, doors } = w;
  const fast = saveCloseTest(db, doors.d1, { leaf: 'S', startMoveMs: 100, latchMs: 1200, closedMs: 1500 });
  assert.equal(fast.result, 'fail');
  const slow = saveCloseTest(db, doors.d1, { leaf: 'S', startMoveMs: 100, latchMs: null, closedMs: null });
  assert.equal(slow.result, 'fail');
  const ok = saveCloseTest(db, doors.d1, { leaf: 'S', startMoveMs: 260, latchMs: 2400, closedMs: 2700 });
  assert.equal(ok.result, 'pass');

  const good = [
    { leaf: 'A', latchMs: 2700 }, { leaf: 'B', latchMs: 2350 },
  ];
  assert.equal(evaluateSequence(good).ok, true);
  const bad = [
    { leaf: 'A', latchMs: 2200 }, { leaf: 'B', latchMs: 2500 },
  ];
  assert.equal(evaluateSequence(bad).ok, false);
});

test('停用门体：完全封堵标记，维修占用时不可停用；停用后不可上报', () => {
  const { db, users, doors } = w;
  const f = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  const o = createRepairOrder(db, users.repair, f.id);
  assert.throws(() => setDecommissioned(db, users.manager, doors.d1, { active: true, seal: 'sealed' }), (e) => e.code === 'door_occupied');
  db.prepare("UPDATE repair_orders SET status='cancelled' WHERE id=?").run(o.id);
  const d = setDecommissioned(db, users.manager, doors.d1, { active: true, reason: '封堵', seal: 'sealed' });
  assert.equal(d.decommissioned, 1);
  assert.equal(d.seal_status, 'sealed');
  assert.throws(() => reportFault(db, users.inspector, doors.d1, 'wedged'), (e) => e.code === 'decommissioned');
});

test('逾期维修可统计（due_at 已过且未完工）', () => {
  const { db, users, doors } = w;
  const f = reportFault(db, users.inspector, doors.d1, 'speed_fast');
  const o = createRepairOrder(db, users.repair, f.id, { dueHours: 1 });
  db.prepare('UPDATE repair_orders SET due_at=? WHERE id=?')
    .run(new Date(Date.now() - 3600_000).toISOString(), o.id);
  const list = overdueRepairs(db);
  assert.equal(list.length, 1);
  assert.ok(list[0].overdue_hours > 0.5);
});
