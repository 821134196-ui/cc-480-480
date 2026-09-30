"""SQLite 连接与表结构。"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
PRAGMA foreign_keys = ON;

-- 人员（巡检员 / 维修工 / 安全主管 / 物业经理）
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('inspector','repairer','supervisor','manager')),
    zone_scope TEXT NOT NULL DEFAULT '*',   -- '*' 表示全部，否则逗号分隔的分区 id
    active     INTEGER NOT NULL DEFAULT 1
);

-- 楼栋
CREATE TABLE IF NOT EXISTS buildings (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    address TEXT
);

-- 防火分区
CREATE TABLE IF NOT EXISTS fire_zones (
    id          INTEGER PRIMARY KEY,
    building_id INTEGER NOT NULL REFERENCES buildings(id),
    code        TEXT NOT NULL UNIQUE,        -- 如 1F-FZ-01
    name        TEXT NOT NULL,
    floor       TEXT NOT NULL,
    -- 分区平面多边形（归一化坐标，0~100），用于分区图
    polygon     TEXT NOT NULL DEFAULT '[[5,5],[95,5],[95,95],[5,95]]'
);

-- 门体
CREATE TABLE IF NOT EXISTS doors (
    id            INTEGER PRIMARY KEY,
    zone_id       INTEGER NOT NULL REFERENCES fire_zones(id),
    code          TEXT NOT NULL UNIQUE,      -- 门体编号 FM-101
    location      TEXT NOT NULL,             -- 安装位置
    door_type     TEXT NOT NULL CHECK (door_type IN ('normally_open','normally_closed')),
    leaf_count    INTEGER NOT NULL CHECK (leaf_count IN (1,2)),
    status        TEXT NOT NULL DEFAULT 'normal'
                  CHECK (status IN ('normal','pending_repair','temp_controlled','decommissioned')),
    seal_status   TEXT NOT NULL DEFAULT 'intact' CHECK (seal_status IN ('intact','deficient')),
    has_em_release INTEGER NOT NULL DEFAULT 0,
    -- 分区图上的位置与朝向：angle 为门体短线角度（度），len 为短线长度
    map_x         REAL NOT NULL,
    map_y         REAL NOT NULL,
    map_angle     REAL NOT NULL DEFAULT 0,
    decommission_reason TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- 部件：闭门器 closer / 顺序器 sequencer / 电磁释放 em_release
CREATE TABLE IF NOT EXISTS door_components (
    id         INTEGER PRIMARY KEY,
    door_id    INTEGER NOT NULL REFERENCES doors(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('closer','sequencer','em_release')),
    leaf_label TEXT NOT NULL DEFAULT '',      -- 双扇时标注 主动扇/从动扇
    model      TEXT,
    serial     TEXT,
    status     TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','faulty')),
    installed_at TEXT,
    UNIQUE (door_id, kind, leaf_label)
);

-- 巡检路线（有序门 id 列表存 JSON）
CREATE TABLE IF NOT EXISTS inspection_routes (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    zone_ids    TEXT NOT NULL,               -- 路线覆盖的分区
    door_order  TEXT NOT NULL,               -- JSON: [door_id,...]
    frequency   TEXT NOT NULL DEFAULT 'daily'
);

-- 巡检任务（进程内调度生成）
CREATE TABLE IF NOT EXISTS route_tasks (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    route_id    INTEGER NOT NULL REFERENCES inspection_routes(id),
    assigned_to INTEGER NOT NULL REFERENCES users(id),
    due_at      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','in_progress','done','skipped')),
    started_at  TEXT,
    finished_at TEXT,
    created_at  TEXT NOT NULL
);

-- 门体巡检记录（一次任务中对一扇门的部件检查）
CREATE TABLE IF NOT EXISTS door_inspections (
    id           INTEGER PRIMARY KEY,
    task_id      INTEGER NOT NULL REFERENCES route_tasks(id) ON DELETE CASCADE,
    door_id      INTEGER NOT NULL REFERENCES doors(id),
    inspector_id INTEGER NOT NULL REFERENCES users(id),
    fan_ok       INTEGER NOT NULL,            -- 门扇
    frame_ok     INTEGER NOT NULL,            -- 门框
    close_seconds REAL,                       -- 闭门速度（90° 到全关，秒）
    sequence_ok  INTEGER,                      -- 双扇顺序关闭（单扇为空）
    linkage_ok   INTEGER,                      -- 释放联动 / 信号回传（常开型）
    accessible   INTEGER NOT NULL DEFAULT 1,  -- 现场是否可进入
    wedged       INTEGER NOT NULL DEFAULT 0,  -- 是否被楔开
    result       TEXT NOT NULL CHECK (result IN ('pass','fail')),
    note         TEXT,
    photo_path   TEXT,
    created_at   TEXT NOT NULL
);

-- 故障工单（唯一编号）
CREATE TABLE IF NOT EXISTS faults (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    door_id     INTEGER NOT NULL REFERENCES doors(id),
    fault_type  TEXT NOT NULL CHECK (fault_type IN (
                    'wedged','closing_too_fast','sequence_error',
                    'no_signal','inaccessible','repair_timeout','reset_failed',
                    'fan_damaged','frame_defect','seal_deficient','other')),
    description TEXT,
    found_by    INTEGER NOT NULL REFERENCES users(id),
    found_at    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','in_repair','resolved','closed')),
    related_fault_id INTEGER REFERENCES faults(id),  -- 复位失败挂在原故障下
    photo_path  TEXT,
    closed_at   TEXT,                        -- 仅允许置位一次：同一故障不能重复关闭
    closed_by   INTEGER REFERENCES users(id),
    UNIQUE (door_id, fault_type, related_fault_id)   -- 粗粒度去重
);

-- 维修单
CREATE TABLE IF NOT EXISTS repair_orders (
    id           INTEGER PRIMARY KEY,
    code         TEXT NOT NULL UNIQUE,
    fault_id     INTEGER NOT NULL REFERENCES faults(id),
    door_id      INTEGER NOT NULL REFERENCES doors(id),
    repairer_id  INTEGER NOT NULL REFERENCES users(id),
    status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','in_progress','awaiting_reset','done','cancelled')),
    note         TEXT,
    created_at   TEXT NOT NULL,
    due_at       TEXT NOT NULL,               -- SLA 截止
    started_at   TEXT,
    completed_at TEXT,                        -- 维修完成（待复位）
    reset_at     TEXT,                        -- 复位合格
    timeout_fired INTEGER NOT NULL DEFAULT 0
);
-- 同一时刻一扇门只允许一张活动维修单占用
CREATE UNIQUE INDEX IF NOT EXISTS one_active_order_per_door
    ON repair_orders(door_id)
    WHERE status IN ('open','in_progress','awaiting_reset');

-- 维修步骤（必须全部完成才能提交复位）
CREATE TABLE IF NOT EXISTS repair_steps (
    id        INTEGER PRIMARY KEY,
    order_id  INTEGER NOT NULL REFERENCES repair_orders(id) ON DELETE CASCADE,
    step_key  TEXT NOT NULL,
    label     TEXT NOT NULL,
    required  INTEGER NOT NULL DEFAULT 1,
    done      INTEGER NOT NULL DEFAULT 0,
    done_at   TEXT,
    done_by   INTEGER REFERENCES users(id),
    note      TEXT,
    UNIQUE (order_id, step_key)
);

-- 临时措施（安全主管批准，有期限）
CREATE TABLE IF NOT EXISTS temp_measures (
    id          INTEGER PRIMARY KEY,
    door_id     INTEGER NOT NULL REFERENCES doors(id),
    fault_id    INTEGER REFERENCES faults(id),
    measure_type TEXT NOT NULL DEFAULT 'seal_control', -- 临时封控/值守等
    reason      TEXT NOT NULL,
    approved_by INTEGER NOT NULL REFERENCES users(id),
    starts_at   TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','expired','released')),
    released_at TEXT,
    released_by INTEGER REFERENCES users(id)
);

-- 复位测试
CREATE TABLE IF NOT EXISTS reset_tests (
    id           INTEGER PRIMARY KEY,
    code         TEXT NOT NULL UNIQUE,
    order_id     INTEGER NOT NULL REFERENCES repair_orders(id),
    door_id      INTEGER NOT NULL REFERENCES doors(id),
    tester_id    INTEGER NOT NULL REFERENCES users(id),
    fan_ok       INTEGER NOT NULL,
    frame_ok     INTEGER NOT NULL,
    close_seconds REAL NOT NULL,              -- 主动扇/单扇关闭用时
    close_seconds_secondary REAL,             -- 从动扇用时（双扇）
    sequence_ok  INTEGER,                      -- 双扇：从动扇先于主动扇关严
    linkage_ok   INTEGER,                      -- 联动释放并信号回传
    seal_ok      INTEGER NOT NULL,
    result       TEXT NOT NULL CHECK (result IN ('pass','fail')),
    fail_reasons TEXT,                         -- JSON 数组
    note         TEXT,
    created_at   TEXT NOT NULL
);
-- 闭门过程时间刻度轨迹：JSON [[t, angle], ...]，angle 90°→0°
CREATE TABLE IF NOT EXISTS reset_traces (
    id          INTEGER PRIMARY KEY,
    reset_id    INTEGER NOT NULL REFERENCES reset_tests(id) ON DELETE CASCADE,
    leaf_label  TEXT NOT NULL,                -- 单扇/主动扇/从动扇
    samples     TEXT NOT NULL
);

-- 模拟适配器的电磁释放信号日志
CREATE TABLE IF NOT EXISTS release_signals (
    id          INTEGER PRIMARY KEY,
    door_id     INTEGER NOT NULL REFERENCES doors(id),
    command     TEXT NOT NULL,                -- release / verify
    ok          INTEGER NOT NULL,
    response_ms INTEGER,
    raw         TEXT,
    created_at  TEXT NOT NULL
);

-- 进程内调度生成的提醒
CREATE TABLE IF NOT EXISTS reminders (
    id         INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,                 -- inspection_due / repair_due / measure_expiring ...
    ref_type   TEXT NOT NULL,
    ref_id     INTEGER NOT NULL,
    message    TEXT NOT NULL,
    due_at     TEXT NOT NULL,
    fired      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (kind, ref_type, ref_id)
);

-- 全程留痕
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY,
    ts          TEXT NOT NULL,
    actor_id    INTEGER REFERENCES users(id),
    category    TEXT NOT NULL,
    entity_type TEXT,
    entity_id   INTEGER,
    door_id     INTEGER,
    summary     TEXT NOT NULL,
    data        TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_door ON events(door_id, ts);
CREATE INDEX IF NOT EXISTS idx_faults_door ON faults(door_id);
CREATE INDEX IF NOT EXISTS idx_orders_door ON repair_orders(door_id);
"""


def connect(db_path: str | Path = "data/firedoor.db") -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()
