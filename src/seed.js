import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { iso, hoursAgo, fmt } from './util.js';
import {
  createInspection, checkInspectionItem, reportFault, createRepairOrder,
  startRepair, completeRepair, createResetTest, approveTempMeasure,
  setDecommissioned, saveCloseTest,
} from './services.js';
import { EMReleaseAdapter } from './adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, '..', 'data');
export const PHOTO_DIR = join(DATA_DIR, 'photos');
export const DB_PATH = join(DATA_DIR, 'app.db');

// 生成本地门体照片占位（SVG，浏览器可直接显示）
function writeDoorPhoto(code, label, status) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">
  <rect width="480" height="320" fill="#f4f2ee"/>
  <rect x="70" y="36" width="340" height="248" rx="4" fill="#e7e4de" stroke="#3d3b37" stroke-width="4"/>
  <line x1="240" y1="36" x2="240" y2="284" stroke="#3d3b37" stroke-width="3"/>
  <circle cx="222" cy="160" r="6" fill="#3d3b37"/><circle cx="258" cy="160" r="6" fill="#3d3b37"/>
  <rect x="96" y="60" width="120" height="14" rx="3" fill="#9aa0a6"/>
  <text x="240" y="20" font-family="sans-serif" font-size="16" fill="#3d3b37" text-anchor="middle">${code} · ${label}</text>
  <text x="240" y="306" font-family="sans-serif" font-size="13" fill="#b03a2e" text-anchor="middle">${status}</text>
</svg>`;
  const path = join(PHOTO_DIR, `${code}.svg`);
  writeFileSync(path, svg);
  return `photos/${code}.svg`;
}

export function seed(db) {
  mkdirSync(PHOTO_DIR, { recursive: true });

  const ins = db.prepare('INSERT INTO users(name,role,zone_ids) VALUES(?,?,?)');
  const U = {};
  const addUser = (key, name, role, zones = []) => {
    U[key] = Number(ins.run(name, role, JSON.stringify(zones)).lastInsertRowid);
  };
  addUser('manager', '王安全', 'safety_manager');
  addUser('inspector', '赵巡检', 'inspector');
  addUser('inspectorZ1', '孙小巡', 'inspector');          // 仅一层分区权限
  addUser('repairer', '周大锤', 'repair');
  addUser('repairerB1', '吴地下', 'repair');               // 仅地库分区权限

  const bId = Number(db.prepare("INSERT INTO buildings(name,address) VALUES(?,?)")
    .run('云锦花园 1 号楼', '云锦路 88 号').lastInsertRowid);

  const zins = db.prepare('INSERT INTO zones(building_id,code,name,floor,px,py,pw,ph) VALUES(?,?,?,?,?,?,?,?)');
  const Z = {};
  const addZone = (key, code, name, floor, x, y, w, h) => {
    Z[key] = Number(zins.run(bId, code, name, floor, x, y, w, h).lastInsertRowid);
  };
  addZone('z1', 'Z-101', '一层大堂防火分区', '1F', 40, 40, 360, 230);
  addZone('zb', 'Z-B1', '地下车库防火分区', 'B1', 470, 40, 390, 230);
  addZone('z2', 'Z-201', '二层办公防火分区', '2F', 180, 330, 520, 270);
  // 孙小巡仅 Z-101；吴地下仅 Z-B1
  db.prepare('UPDATE users SET zone_ids=? WHERE id=?').run(JSON.stringify([Z.z1]), U.inspectorZ1);
  db.prepare('UPDATE users SET zone_ids=? WHERE id=?').run(JSON.stringify([Z.zb]), U.repairerB1);

  // 门体几何：分区图上的短线 [gx, gy, angle]
  const dins = db.prepare(`
    INSERT INTO doors(zone_id,code,name,door_type,leaf_count,status,gx,gy,gangle,glen,note)
    VALUES(?,?,?,?,?,?,?,?,?,26,?)`);
  const D = {};
  const addDoor = (key, zone, code, name, type, leaves, [gx, gy, ang], note = '') => {
    D[key] = Number(dins.run(zone, code, name, type, leaves, 'normal', gx, gy, ang, note).lastInsertRowid);
  };
  // Z-101 矩形周边
  addDoor('d101', Z.z1, 'FM-101', '一层东通道防火门', 'NC', 1, [220, 40, 0]);
  addDoor('d102', Z.z1, 'FM-102', '大堂双扇防火门', 'NC', 2, [400, 150, 90]);
  addDoor('d103', Z.z1, 'FM-103', '消防前室常开防火门', 'NO', 2, [220, 270, 0]);
  addDoor('d104', Z.z1, 'FM-104', '楼梯间常闭防火门', 'NC', 1, [40, 150, 90]);
  // Z-B1
  addDoor('db01', Z.zb, 'FM-B01', '车库入口防火门', 'NC', 1, [665, 40, 0]);
  addDoor('db02', Z.zb, 'FM-B02', '车道常开防火门', 'NO', 1, [860, 150, 90]);
  addDoor('db03', Z.zb, 'FM-B03', '泵房防火门', 'NC', 1, [665, 270, 0]);
  addDoor('db04', Z.zb, 'FM-B04', '废弃管井门（停用）', 'NC', 1, [470, 150, 90], '管井封堵，门体停用');
  // Z-201
  addDoor('d201', Z.z2, 'FM-201', '办公区西防火门', 'NC', 1, [180, 465, 90]);
  addDoor('d202', Z.z2, 'FM-202', '会议区常开双扇门', 'NO', 2, [440, 330, 0]);
  addDoor('d203', Z.z2, 'FM-203', '走廊常闭防火门', 'NC', 1, [700, 465, 90]);
  addDoor('d204', Z.z2, 'FM-204', '东侧疏散双扇门', 'NC', 2, [440, 600, 0]);

  // 部件：闭门器（全部）、顺序器（双扇）、电磁释放（常开）
  const cins = db.prepare('INSERT INTO components(door_id,kind,model,serial,installed_at) VALUES(?,?,?,?,?)');
  for (const [key, id] of Object.entries(D)) {
    const d = db.prepare('SELECT * FROM doors WHERE id=?').get(id);
    cins.run(id, 'closer', 'CB-65 液压闭门器', `CL-${d.code}`, '2025-03-12');
    if (d.leaf_count === 2) cins.run(id, 'sequencer', 'SQ-2 顺位器', `SQ-${d.code}`, '2025-03-12');
    if (d.door_type === 'NO') cins.run(id, 'em_release', 'EM-24V 电磁释放器', `EM-${d.code}`, '2025-03-12');
  }

  // 照片
  for (const id of Object.values(D)) {
    const d = db.prepare('SELECT * FROM doors WHERE id=?').get(id);
    const path = writeDoorPhoto(d.code, d.name, d.note || '现场照片');
    db.prepare('INSERT INTO photos(door_id,ref_type,path,caption,at) VALUES(?,?,?,?,?)')
      .run(id, 'door', path, `${d.code} 门体照片`, iso());
  }

  const adapter = new EMReleaseAdapter({ db });
  // FM-103 电磁释放器信号无回传（持久化故障脚本，重启后演示一致；维修后可通过接口清除）
  adapter.setScript('FM-103', 'no_feedback');
  const manager = { id: U.manager, name: '王安全', role: 'safety_manager', zone_ids: '[]' };
  const inspector = { id: U.inspector, name: '赵巡检', role: 'inspector', zone_ids: '[]' };
  const inspectorZ1 = { id: U.inspectorZ1, name: '孙小巡', role: 'inspector', zone_ids: JSON.stringify([Z.z1]) };
  const repairer = { id: U.repairer, name: '周大锤', role: 'repair', zone_ids: '[]' };

  // ---- 样例 1：闭门过快 + 超时维修（FM-101） ----
  let ins1 = createInspection(db, inspector, {
    title: '一层大堂早班巡检', doorIds: [D.d101, D.d102, D.d103, D.d104], plannedAt: hoursAgo(30), dueHours: 4,
  });
  const byDoor1 = Object.fromEntries(ins1.items.map(i => [i.door_code, i.id]));
  saveCloseTest(db, D.d101, { leaf: 'S', startMoveMs: 150, latchMs: 1200, closedMs: 1500, refType: 'inspection', at: hoursAgo(29) });
  checkInspectionItem(db, inspector, byDoor1['FM-101'], {
    result: 'fail', aspects: { leaf: 'pass', frame: 'pass', speed: 'fail', sequence: 'na' },
    note: '闭门器阻尼失效，1.5s 猛烈撞击',
  });

  // ---- 样例 2：门体被楔开（FM-102） ----
  const tA = saveCloseTest(db, D.d102, { leaf: 'A', startMoveMs: 200, latchMs: 2200, closedMs: 2500, refType: 'inspection', at: hoursAgo(29) });
  saveCloseTest(db, D.d102, { leaf: 'B', startMoveMs: 200, latchMs: 2500, closedMs: 2800, refType: 'inspection', at: hoursAgo(29) });
  checkInspectionItem(db, inspector, byDoor1['FM-102'], {
    result: 'fail', aspects: { leaf: 'pass', frame: 'pass', speed: 'pass', sequence: 'fail' },
    wedged: true, note: '商户用木楔固定双扇门，顺位器被别住',
  });

  // ---- 样例 3：电磁释放联动失败（FM-103，常开双扇） ----
  saveCloseTest(db, D.d103, { leaf: 'A', startMoveMs: 300, latchMs: 2600, closedMs: 2900, refType: 'inspection', at: hoursAgo(29) });
  saveCloseTest(db, D.d103, { leaf: 'B', startMoveMs: 300, latchMs: 2400, closedMs: 2700, refType: 'inspection', at: hoursAgo(29) });
  checkInspectionItem(db, inspector, byDoor1['FM-103'], {
    result: 'fail', aspects: { leaf: 'pass', frame: 'pass', speed: 'pass', sequence: 'pass', check_linkage: true },
    note: '联动指令下发后无回传', emAdapter: adapter,
  });
  checkInspectionItem(db, inspector, byDoor1['FM-104'], {
    result: 'pass', aspects: { leaf: 'pass', frame: 'pass', speed: 'pass', sequence: 'na' },
  });

  const findFault = (doorId, kind) =>
    db.prepare('SELECT * FROM faults WHERE door_id=? AND kind=? ORDER BY id DESC').get(doorId, kind);

  // FM-101 维修单（超时）
  const f101 = findFault(D.d101, 'speed_fast');
  const o101 = createRepairOrder(db, repairer, f101.id, { dueHours: 8 });
  startRepair(db, repairer, o101.id);
  db.prepare('UPDATE repair_orders SET created_at=?, due_at=? WHERE id=?')
    .run(iso(hoursAgo(26)), iso(hoursAgo(18)), o101.id);
  // 同步把超时提醒置为过去，启动时由调度器补跑并写维修超时留痕
  db.prepare("UPDATE reminders SET at=? WHERE type='repair_overdue' AND ref_type='repair_order' AND ref_id=?")
    .run(iso(hoursAgo(18)), o101.id);

  // FM-102 楔门维修单（进行中，占用门体）
  const f102 = findFault(D.d102, 'wedged');
  const o102 = createRepairOrder(db, repairer, f102.id, { dueHours: 24 });
  startRepair(db, repairer, o102.id);

  // FM-103 维修完工后复位测试被退回（另一个人测试）
  const f103 = findFault(D.d103, 'no_signal');
  const o103 = createRepairOrder(db, repairer, f103.id, { dueHours: 24 });
  startRepair(db, repairer, o103.id);
  completeRepair(db, repairer, o103.id, { workNote: '更换联动模块，现场手动释放正常，待联动复测' });
  const rst103 = createResetTest(db, inspector, o103.id, {
    items: { door_leaf: 'pass', frame: 'pass', close_speed: 'pass', sequence: 'pass', auto_linkage: true },
    note: '消控室下发联动指令', emAdapter: adapter,
  });
  // 复位退回后再次维修尚未开始，门体保持 reset_failed

  // ---- 临时封控样例（FM-B01）：安全主管批准，2 小时后到期 ----
  const fb01 = reportFault(db, inspector, D.db01, 'wedged', { detail: { seed: true, note: '闭门器断裂' } });
  approveTempMeasure(db, manager, D.db01, {
    reason: '车库入口门闭门器断裂，设置临时护栏与警示带封控', expireHours: 2, faultId: fb01.id,
  });

  // 历史：FM-203 曾有临时措施并已到期解除
  db.prepare(`INSERT INTO temp_measures(door_id,reason,approved_by,approved_at,expire_at,status)
    VALUES(?,?,?,?,?,?)`).run(D.d203, '闭门器渗油临时封闭', U.manager, iso(hoursAgo(76)), iso(hoursAgo(48)), 'expired');

  // ---- 无法进入留痕样例（FM-B03，地库巡检） ----
  const insB = createInspection(db, inspector, {
    title: '地下车库例行巡检', doorIds: [D.db01, D.db02, D.db03], plannedAt: hoursAgo(6), dueHours: 6,
  });
  const bMap = Object.fromEntries(insB.items.map(i => [i.door_code, i.id]));
  checkInspectionItem(db, inspector, bMap['FM-B03'], { result: 'na', note: '泵房积水，现场无法进入' });
  // 该巡检其余两门保持 pending，整体逾期

  // ---- FM-B04 停用 + 完全封堵 ----
  setDecommissioned(db, manager, D.db04, { active: true, reason: '管井废弃，砌体封堵', seal: 'sealed' });

  // ---- 正常门体的合格闭门曲线，供时间刻度对照 ----
  saveCloseTest(db, D.d201, { leaf: 'S', startMoveMs: 280, latchMs: 2300, closedMs: 2700, refType: 'inspection', at: hoursAgo(20) });
  saveCloseTest(db, D.d204, { leaf: 'A', startMoveMs: 260, latchMs: 2700, closedMs: 3000, refType: 'inspection', at: hoursAgo(20) });
  saveCloseTest(db, D.d204, { leaf: 'B', startMoveMs: 260, latchMs: 2350, closedMs: 2650, refType: 'inspection', at: hoursAgo(20) });

  // ---- 即将开始的巡检任务（进程内提醒演示） ----
  createInspection(db, inspector, {
    title: '二层办公区夜间巡检', doorIds: [D.d201, D.d202, D.d203, D.d204, D.db02],
    plannedAt: new Date(Date.now() + 2 * 3600_000), dueHours: 6,
  });

  return { users: U, zones: Z, doors: D, orders: { o101: o101.id, o102: o102.id, o103: o103.id }, resetFail: rst103.id };
}

export function initDbFile(path = DB_PATH) {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = openDb(path);
  const count = db.prepare('SELECT COUNT(*) c FROM doors').get().c;
  let seeded = false;
  if (count === 0) { seed(db); seeded = true; }
  return { db, seeded };
}

// 允许 node src/seed.js --reset 重建
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  if (process.argv.includes('--reset')) {
    for (const ext of ['', '-wal', '-shm']) rmSync(DB_PATH + ext, { force: true });
  }
  const { seeded } = initDbFile();
  console.log(seeded ? '已创建演示数据库' : '数据库已存在，未重复播种');
}
