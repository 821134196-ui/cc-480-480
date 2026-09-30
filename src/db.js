import { DatabaseSync } from 'node:sqlite';

// 门体状态
export const DOOR_STATUS = {
  NORMAL: 'normal',                 // 正常
  PENDING_REPAIR: 'pending_repair', // 待维修
  REPAIRING: 'repairing',           // 维修中
  TEMP_BLOCKED: 'temp_blocked',     // 临时封控
  AWAIT_RESET: 'await_reset',       // 待复位
  RESET_FAILED: 'reset_failed',     // 复位退回
  DECOMMISSIONED: 'decommissioned', // 停用
};

// 封堵情况
export const SEAL_STATUS = {
  NONE: 'none',       // 无封堵
  PARTIAL: 'partial', // 部分封堵
  SEALED: 'sealed',   // 完全封堵（须停用）
  TEMP: 'temp',       // 临时封堵（安全主管批准）
};

export const FAULT_STATUS = {
  OPEN: 'open',                     // 待维修
  REPAIRING: 'repairing',           // 维修中
  TEMP_BLOCKED: 'temp_blocked',     // 临时封控
  AWAIT_RESET: 'await_reset',       // 维修完成，待复位
  RESET_FAILED: 'reset_failed',     // 复位退回
  CLOSED: 'closed',                 // 已关闭（终态）
};

export const REPAIR_STATUS = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  CANCELLED: 'cancelled',
};

// 事件类型：楔开 / 闭门过快 / 顺序错误 / 无信号 / 无法进入 / 维修超时 / 复位失败 ……
export const EVENT_TYPES = {
  WEDGED: 'wedged',
  CLOSE_FAST: 'close_fast',
  SEQ_ERROR: 'seq_error',
  NO_SIGNAL: 'no_signal',
  INACCESSIBLE: 'inaccessible',
  REPAIR_OVERDUE: 'repair_overdue',
  RESET_FAIL: 'reset_fail',
  TEMP_APPROVED: 'temp_approved',
  TEMP_EXPIRED: 'temp_expired',
  REPAIR_DONE: 'repair_done',
  RESET_PASS: 'reset_pass',
  DECOMMISSION: 'decommission',
  REACTIVATE: 'reactivate',
  INSPECTION_DUE: 'inspection_due',
};

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('inspector','repair','safety_manager','admin')),
  zone_ids TEXT NOT NULL DEFAULT '[]',  -- 区域权限；[] 表示全部
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS buildings (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS zones (            -- 防火分区
  id INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  floor TEXT NOT NULL DEFAULT '',
  px REAL NOT NULL DEFAULT 60,                -- 分区图矩形
  py REAL NOT NULL DEFAULT 60,
  pw REAL NOT NULL DEFAULT 300,
  ph REAL NOT NULL DEFAULT 180
);

CREATE TABLE IF NOT EXISTS doors (
  id INTEGER PRIMARY KEY,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  code TEXT NOT NULL UNIQUE,                  -- 门体编号
  name TEXT NOT NULL DEFAULT '',
  door_type TEXT NOT NULL CHECK (door_type IN ('NC','NO')),  -- 常闭 / 常开
  leaf_count INTEGER NOT NULL DEFAULT 1 CHECK (leaf_count IN (1,2)),
  status TEXT NOT NULL DEFAULT 'normal',
  seal_status TEXT NOT NULL DEFAULT 'none',
  decommissioned INTEGER NOT NULL DEFAULT 0,
  gx REAL NOT NULL DEFAULT 0,                 -- 分区图门体短线中点
  gy REAL NOT NULL DEFAULT 0,
  gangle REAL NOT NULL DEFAULT 0,             -- 短线角度（度）
  glen REAL NOT NULL DEFAULT 26,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS components (      -- 闭门器 / 顺序器 / 电磁释放
  id INTEGER PRIMARY KEY,
  door_id INTEGER NOT NULL REFERENCES doors(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('closer','sequencer','em_release')),
  model TEXT NOT NULL DEFAULT '',
  serial TEXT NOT NULL DEFAULT '',
  installed_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok'          -- ok / faulty
);

CREATE TABLE IF NOT EXISTS inspections (     -- 路线巡检任务
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  inspector_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'     -- pending/in_progress/done
    CHECK (status IN ('pending','in_progress','done')),
  planned_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS inspection_items (
  id INTEGER PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  door_id INTEGER NOT NULL REFERENCES doors(id),
  order_idx INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT 'pending'     -- pending/pass/fail/na
    CHECK (result IN ('pending','pass','fail','na')),
  aspects TEXT NOT NULL DEFAULT '{}',        -- 门扇/门框/速度/顺序/联动 检查项
  checked_at TEXT,
  checked_by INTEGER REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  UNIQUE (inspection_id, door_id)
);

CREATE TABLE IF NOT EXISTS faults (          -- 故障工单
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  door_id INTEGER NOT NULL REFERENCES doors(id),
  inspection_item_id INTEGER REFERENCES inspection_items(id),
  kind TEXT NOT NULL,                        -- wedged/speed_fast/seq_error/no_signal/inaccessible/reset_fail/other
  title TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  reporter_id INTEGER REFERENCES users(id),
  reported_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  closed_at TEXT,
  close_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS repair_orders (   -- 维修单
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  fault_id INTEGER NOT NULL REFERENCES faults(id),
  door_id INTEGER NOT NULL REFERENCES doors(id),
  assignee_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','done','cancelled')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  due_at TEXT,
  finished_at TEXT,
  work_note TEXT NOT NULL DEFAULT '',
  reset_failure_count INTEGER NOT NULL DEFAULT 0
);
-- 同一时间两个维修单不能占用同一门体
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_repair_per_door
  ON repair_orders(door_id) WHERE status IN ('open','in_progress');

CREATE TABLE IF NOT EXISTS reset_tests (     -- 复位测试
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  repair_order_id INTEGER NOT NULL REFERENCES repair_orders(id),
  fault_id INTEGER NOT NULL REFERENCES faults(id),
  door_id INTEGER NOT NULL REFERENCES doors(id),
  tester_id INTEGER NOT NULL REFERENCES users(id),
  tested_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('pass','fail')),
  items TEXT NOT NULL DEFAULT '{}',          -- 五项全部合格才 pass
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS close_tests (     -- 闭门测试（时间刻度数据）
  id INTEGER PRIMARY KEY,
  door_id INTEGER NOT NULL REFERENCES doors(id),
  at TEXT NOT NULL,
  ref_type TEXT NOT NULL DEFAULT '',         -- inspection / reset / manual
  leaf TEXT NOT NULL DEFAULT 'A',            -- A 扇 / B 扇 / S 单扇
  open_angle REAL NOT NULL DEFAULT 90,
  start_move_ms INTEGER,                     -- 开始动作（毫秒）
  latch_ms INTEGER,                          -- 进入锁口
  closed_ms INTEGER,                         -- 完全关闭
  result TEXT NOT NULL DEFAULT 'pass'        -- pass/fail：过快/过慢/无法闭合
);

CREATE TABLE IF NOT EXISTS temp_measures (   -- 临时措施（安全主管批准）
  id INTEGER PRIMARY KEY,
  door_id INTEGER NOT NULL REFERENCES doors(id),
  fault_id INTEGER REFERENCES faults(id),
  measure_type TEXT NOT NULL DEFAULT 'block',
  reason TEXT NOT NULL DEFAULT '',
  approved_by INTEGER NOT NULL REFERENCES users(id),
  approved_at TEXT NOT NULL,
  expire_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'      -- active/expired/revoked
    CHECK (status IN ('active','expired','revoked')),
  revoked_at TEXT,
  revoke_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  door_id INTEGER NOT NULL REFERENCES doors(id),
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id INTEGER,
  path TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (          -- 事件留痕总账
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  door_id INTEGER REFERENCES doors(id),
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id INTEGER,
  actor_id INTEGER REFERENCES users(id),
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS reminders (       -- 进程内任务生成
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id INTEGER,
  message TEXT NOT NULL,
  fired INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- 电磁释放模拟适配器的持久化故障脚本（演示用）
CREATE TABLE IF NOT EXISTS release_scripts (
  door_code TEXT PRIMARY KEY,
  mode TEXT NOT NULL,              -- ok / no_feedback / no_release
  updated_at TEXT NOT NULL
);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function nextSeq(db, key) {
  db.prepare('INSERT INTO counters(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1')
    .run(key);
  return db.prepare('SELECT value FROM counters WHERE key=?').get(key).value;
}
