import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, DOOR_STATUS } from '../src/db.js';
import { reportFault, approveTempMeasure } from '../src/services.js';
import { Scheduler } from '../src/scheduler.js';

// 进程内任务：到点触发提醒；临时措施到期自动失效、门体回待维修并留痕
test('调度器：临时措施到期自动处理', () => {
  const db = openDb(':memory:');
  const mId = Number(db.prepare("INSERT INTO users(name,role,zone_ids) VALUES('主管','safety_manager','[]')").run().lastInsertRowid);
  const iId = Number(db.prepare("INSERT INTO users(name,role,zone_ids) VALUES('巡检','inspector','[]')").run().lastInsertRowid);
  const b = Number(db.prepare("INSERT INTO buildings(name) VALUES('B')").run().lastInsertRowid);
  const z = Number(db.prepare("INSERT INTO zones(building_id,code,name,px,py,pw,ph) VALUES(?,?,?,60,60,300,180)").run(b, 'Z1', '分区').lastInsertRowid);
  const d = Number(db.prepare("INSERT INTO doors(zone_id,code,door_type,leaf_count,gx,gy) VALUES(?, 'FM-1','NC',1,1,1)").run(z).lastInsertRowid);
  const manager = db.prepare('SELECT * FROM users WHERE id=?').get(mId);
  const inspector = db.prepare('SELECT * FROM users WHERE id=?').get(iId);

  const f = reportFault(db, inspector, d, 'wedged');
  const m = approveTempMeasure(db, manager, d, { reason: '临时封控', expireHours: 2, faultId: f.id });
  assert.equal(db.prepare('SELECT status FROM doors WHERE id=?').get(d).status, DOOR_STATUS.TEMP_BLOCKED);

  const sch = new Scheduler(db, { intervalMs: 9_999_999 });
  // 未到点不触发
  assert.equal(sch.tick(new Date()).length, 0);
  assert.equal(db.prepare('SELECT status FROM temp_measures WHERE id=?').get(m.id).status, 'active');

  // 3 小时后：到期，自动失效
  const fired = sch.tick(new Date(Date.now() + 3 * 3600_000));
  assert.ok(fired.some(r => r.type === 'temp_expired'));
  assert.equal(db.prepare('SELECT status FROM temp_measures WHERE id=?').get(m.id).status, 'expired');
  assert.equal(db.prepare('SELECT status FROM doors WHERE id=?').get(d).status, DOOR_STATUS.PENDING_REPAIR);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE type='temp_expired'").get().c, 1);

  // 幂等：再次扫描不重复处理
  const again = sch.tick(new Date(Date.now() + 4 * 3600_000));
  assert.equal(again.length, 0);
});
