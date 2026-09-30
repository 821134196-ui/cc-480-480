"""业务服务层：工单唯一、步骤完整、职责分离、临时措施到期、区域权限、全程留痕。"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable

from .db import connect, init_db

# ---------- 标准与常量 ----------

CLOSE_SECONDS_MIN = 3.0     # 快于该值视为闭门过快（猛烈撞击）
CLOSE_SECONDS_MAX = 10.0    # 慢于该值视为闭门迟缓
RESET_PASS_WINDOW = (CLOSE_SECONDS_MIN, CLOSE_SECONDS_MAX)

FAULT_LABELS = {
    "wedged": "门体被楔开",
    "closing_too_fast": "闭门过快",
    "sequence_error": "双扇顺序错误",
    "no_signal": "信号无回传",
    "inaccessible": "现场无法进入",
    "repair_timeout": "维修超时",
    "reset_failed": "复位失败",
    "fan_damaged": "门扇损伤",
    "frame_defect": "门框缺陷",
    "seal_deficient": "防火封堵缺陷",
    "other": "其他故障",
}

REPAIR_STEP_TEMPLATES = [
    ("scene", "现场警戒与临时封控核对"),
    ("disassemble", "部件拆卸检查（闭门器/顺序器/释放装置）"),
    ("fix", "维修或更换缺陷部件"),
    ("speed", "闭门速度调校（3~10 秒区间）"),
    ("linkage", "顺序关闭与电磁释放联动恢复"),
    ("selfcheck", "现场清理与维修自检"),
]

ROLE_CAN_TEMP_APPROVE = {"supervisor", "manager"}
ROLE_CAN_DECOMMISSION = {"supervisor", "manager"}


class ServiceError(Exception):
    """业务规则冲突（4xx 语义）。"""


def now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


# ---------- 模拟电磁释放适配器 ----------

class ReleaseAdapter:
    """模拟防火门电磁释放器：下发释放指令并读取回传信号。

    fail_doors 中的门模拟联动失败（无回传），其余返回成功。
    """

    def __init__(self, fail_doors: Iterable[int] = ()) -> None:
        self.fail_doors = set(fail_doors)

    def _latency_ms(self, door_id: int) -> int:
        h = int(hashlib.md5(f"door-{door_id}".encode()).hexdigest(), 16)
        return 120 + h % 380  # 120~499ms，确定性演示值

    def release(self, door_id: int) -> dict[str, Any]:
        ok = door_id not in self.fail_doors
        return {
            "ok": ok,
            "response_ms": None if not ok else self._latency_ms(door_id),
            "raw": json.dumps(
                {"cmd": "RELEASE", "door": door_id,
                 "ack": ok, "fault": "NO_FEEDBACK" if not ok else None},
                ensure_ascii=False),
        }


# ---------- 服务 ----------

class FireDoorService:
    def __init__(self, db_path: str | Path = "data/firedoor.db",
                 clock: Callable[[], datetime] | None = None,
                 release_adapter: ReleaseAdapter | None = None,
                 photo_dir: str | Path = "data/photos") -> None:
        self.conn = connect(db_path)
        init_db(self.conn)
        self.clock = clock or datetime.now
        self.adapter = release_adapter or ReleaseAdapter()
        self.photo_dir = Path(photo_dir)
        self.photo_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def now(self) -> datetime:
        return self.clock()

    def iso(self, dt: datetime | None = None) -> str:
        return (dt or self.now()).replace(microsecond=0).isoformat()

    # ===== 基础工具 =====

    def _event(self, category: str, summary: str, *, actor_id: int | None = None,
               entity_type: str | None = None, entity_id: int | None = None,
               door_id: int | None = None, data: dict | None = None) -> None:
        self.conn.execute(
            "INSERT INTO events(ts,actor_id,category,entity_type,entity_id,door_id,summary,data)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (self.iso(), actor_id, category, entity_type, entity_id, door_id, summary,
             json.dumps(data, ensure_ascii=False) if data else None))
        self.conn.commit()

    def get_user(self, user_id: int) -> sqlite3.Row:
        row = self.conn.execute("SELECT * FROM users WHERE id=? AND active=1", (user_id,)).fetchone()
        if not row:
            raise ServiceError(f"用户 {user_id} 不存在或已停用")
        return row

    def _require_zone(self, user: sqlite3.Row, zone_id: int) -> None:
        """区域权限：scope 为 '*' 或包含该分区 id。"""
        scope = (user["zone_scope"] or "*").strip()
        if scope == "*":
            return
        allowed = {int(x) for x in scope.split(",") if x.strip()}
        if zone_id not in allowed:
            raise ServiceError(f"用户 {user['name']} 无权操作防火分区 {zone_id}")

    def _door_zone(self, door_id: int) -> int:
        row = self.conn.execute("SELECT zone_id FROM doors WHERE id=?", (door_id,)).fetchone()
        if not row:
            raise ServiceError(f"门体 {door_id} 不存在")
        return row["zone_id"]

    def require_door_access(self, user_id: int, door_id: int) -> sqlite3.Row:
        user = self.get_user(user_id)
        self._require_zone(user, self._door_zone(door_id))
        return user

    # ===== 查询视图 =====

    def list_buildings(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM buildings ORDER BY id").fetchall()

    def list_zones(self, building_id: int | None = None) -> list[sqlite3.Row]:
        sql = "SELECT * FROM fire_zones"
        args: tuple = ()
        if building_id:
            sql += " WHERE building_id=?"
            args = (building_id,)
        return self.conn.execute(sql + " ORDER BY building_id, code", args).fetchall()

    def zone_map(self, zone_id: int) -> dict:
        zone = self.conn.execute("SELECT * FROM fire_zones WHERE id=?", (zone_id,)).fetchone()
        if not zone:
            raise ServiceError("分区不存在")
        doors = self.conn.execute(
            "SELECT * FROM doors WHERE zone_id=? ORDER BY code", (zone_id,)).fetchall()
        comps = []
        if doors:
            ids = ",".join(str(d["id"]) for d in doors)
            comps = self.conn.execute(
                f"SELECT * FROM door_components WHERE door_id IN ({ids})").fetchall()
        return {"zone": zone, "doors": doors, "components": comps}

    def door_detail(self, door_id: int) -> dict:
        door = self.conn.execute("SELECT * FROM doors WHERE id=?", (door_id,)).fetchone()
        if not door:
            raise ServiceError("门体不存在")
        zone = self.conn.execute("SELECT * FROM fire_zones WHERE id=?", (door["zone_id"],)).fetchone()
        comps = self.conn.execute("SELECT * FROM door_components WHERE door_id=? ORDER BY kind, leaf_label",
                                  (door_id,)).fetchall()
        faults = self.conn.execute(
            "SELECT f.*, u.name AS found_by_name FROM faults f LEFT JOIN users u ON u.id=f.found_by"
            " WHERE door_id=? ORDER BY found_at DESC", (door_id,)).fetchall()
        orders = self.conn.execute(
            "SELECT o.*, u.name AS repairer_name, f.code AS fault_code FROM repair_orders o"
            " LEFT JOIN users u ON u.id=o.repairer_id LEFT JOIN faults f ON f.id=o.fault_id"
            " WHERE o.door_id=? ORDER BY o.created_at DESC", (door_id,)).fetchall()
        measures = self.conn.execute(
            "SELECT m.*, u.name AS approver_name FROM temp_measures m LEFT JOIN users u ON u.id=m.approved_by"
            " WHERE m.door_id=? ORDER BY m.starts_at DESC", (door_id,)).fetchall()
        events = self.conn.execute(
            "SELECT e.*, u.name AS actor_name FROM events e LEFT JOIN users u ON u.id=e.actor_id"
            " WHERE e.door_id=? ORDER BY e.ts DESC LIMIT 30", (door_id,)).fetchall()
        traces = []
        photos = self.conn.execute(
            "SELECT id, photo_path, created_at FROM door_inspections WHERE door_id=? AND photo_path IS NOT NULL"
            " ORDER BY created_at DESC", (door_id,)).fetchall()
        return {"door": door, "zone": zone, "components": comps, "faults": faults,
                "orders": orders, "measures": measures, "events": events, "photos": photos}

    def list_faults(self, status: str | None = None) -> list[sqlite3.Row]:
        sql = ("SELECT f.*, d.code AS door_code, z.code AS zone_code, u.name AS found_by_name,"
               " o.status AS order_status, o.id AS order_id FROM faults f"
               " JOIN doors d ON d.id=f.door_id JOIN fire_zones z ON z.id=d.zone_id"
               " LEFT JOIN users u ON u.id=f.found_by"
               " LEFT JOIN repair_orders o ON o.fault_id=f.id AND o.status IN ('open','in_progress','awaiting_reset')")
        args: tuple = ()
        if status:
            sql += " WHERE f.status=?"
            args = (status,)
        sql += " ORDER BY f.found_at DESC"
        return self.conn.execute(sql, args).fetchall()

    # ===== 门体状态机 =====

    def _recompute_status(self, door_id: int) -> str:
        """根据停用标记 / 临时措施 / 活动故障与工单推导门体状态。"""
        with self.lock:
            door = self.conn.execute("SELECT status FROM doors WHERE id=?", (door_id,)).fetchone()
            if door["status"] == "decommissioned":
                return "decommissioned"
            active_measure = self.conn.execute(
                "SELECT 1 FROM temp_measures WHERE door_id=? AND status='active' LIMIT 1",
                (door_id,)).fetchone()
            if active_measure:
                status = "temp_controlled"
            else:
                active_fault = self.conn.execute(
                    "SELECT 1 FROM faults WHERE door_id=? AND status IN ('open','in_repair','resolved') LIMIT 1",
                    (door_id,)).fetchone()
                status = "pending_repair" if active_fault else "normal"
            self.conn.execute("UPDATE doors SET status=?, updated_at=? WHERE id=?",
                              (status, self.iso(), door_id))
            self.conn.commit()
            return status

    # ===== 巡检 =====

    def generate_route_tasks(self) -> int:
        """按路线频率生成当日巡检任务（幂等）。"""
        n = 0
        with self.lock:
            for route in self.conn.execute("SELECT * FROM inspection_routes").fetchall():
                # 演示简化：daily 每自然日一单；周期由 frequency 文本驱动
                prefix = self.now().strftime("%Y%m%d")
                code = f"IT-{route['id']}-{prefix}"
                exists = self.conn.execute("SELECT 1 FROM route_tasks WHERE code=?", (code,)).fetchone()
                if exists:
                    continue
                assignee = self.conn.execute(
                    "SELECT id FROM users WHERE role='inspector' AND active=1 ORDER BY id LIMIT 1").fetchone()
                if not assignee:
                    continue
                due = self.now().replace(hour=18, minute=0, second=0, microsecond=0)
                if due <= self.now():  # 晚间初始化：顺延 2 小时，避免演示数据全部逾期
                    due = self.now() + timedelta(hours=2)
                cur = self.conn.execute(
                    "INSERT INTO route_tasks(code,route_id,assigned_to,due_at,created_at)"
                    " VALUES (?,?,?,?,?)",
                    (code, route["id"], assignee["id"], self.iso(due), self.iso()))
                task_id = cur.lastrowid
                self.conn.execute(
                    "INSERT OR IGNORE INTO reminders(kind,ref_type,ref_id,message,due_at,created_at)"
                    " VALUES ('inspection_due','route_task',?,?,?,?)",
                    (task_id, f"巡检任务 {code} 应于 {due.strftime('%H:%M')} 前完成",
                     self.iso(due), self.iso()))
                n += 1
            self.conn.commit()
        return n

    def start_task(self, task_id: int, user_id: int) -> None:
        with self.lock:
            user = self.get_user(user_id)
            task = self.conn.execute("SELECT * FROM route_tasks WHERE id=?", (task_id,)).fetchone()
            if not task:
                raise ServiceError("巡检任务不存在")
            if task["assigned_to"] != user_id and user["role"] != "supervisor":
                raise ServiceError("只能执行分配给自己的巡检任务")
            if task["status"] != "pending":
                raise ServiceError("任务已开始或已结束")
            self.conn.execute("UPDATE route_tasks SET status='in_progress', started_at=? WHERE id=?",
                              (self.iso(), task_id))
            self._event("inspection", f"开始巡检任务 {task['code']}", actor_id=user_id,
                        entity_type="route_task", entity_id=task_id)

    def submit_door_inspection(self, task_id: int, door_id: int, user_id: int, payload: dict) -> dict:
        """提交单扇门的部件检查结果。失败项自动生成故障并将门置为待维修。"""
        with self.lock:
            user = self.require_door_access(user_id, door_id)
            task = self.conn.execute("SELECT * FROM route_tasks WHERE id=?", (task_id,)).fetchone()
            if not task:
                raise ServiceError("巡检任务不存在")
            if task["status"] not in ("in_progress", "pending"):
                raise ServiceError("任务不在执行状态，无法提交检查")
            door = self.conn.execute("SELECT * FROM doors WHERE id=?", (door_id,)).fetchone()
            if door["status"] == "decommissioned":
                raise ServiceError("门体已停用，巡检请登记停用核查而非故障")

            fan_ok = bool(payload.get("fan_ok"))
            frame_ok = bool(payload.get("frame_ok"))
            close_seconds = payload.get("close_seconds")
            accessible = bool(payload.get("accessible", True))
            wedged = bool(payload.get("wedged"))
            note = (payload.get("note") or "").strip()
            photo_path = payload.get("photo_path")
            sequence_ok = payload.get("sequence_ok")
            linkage_ok = payload.get("linkage_ok")

            if close_seconds is not None:
                close_seconds = float(close_seconds)
                if close_seconds <= 0:
                    raise ServiceError("闭门秒数必须为正数")

            # 判定失败项 → 故障类型集合（每种分别留痕，且不重复建单）
            faults_found: list[str] = []
            if not accessible:
                faults_found.append("inaccessible")
            if wedged:
                faults_found.append("wedged")
            if accessible and not fan_ok:
                faults_found.append("fan_damaged")
            if accessible and not frame_ok:
                faults_found.append("frame_defect")
            if accessible and close_seconds is not None and close_seconds < CLOSE_SECONDS_MIN:
                faults_found.append("closing_too_fast")
            if door["leaf_count"] == 2 and sequence_ok is False:
                faults_found.append("sequence_error")
            if door["door_type"] == "normally_open" and accessible and linkage_ok is False:
                faults_found.append("no_signal")
            if door["seal_status"] == "deficient":
                faults_found.append("seal_deficient")

            result = "pass" if not faults_found else "fail"
            cur = self.conn.execute(
                "INSERT INTO door_inspections(task_id,door_id,inspector_id,fan_ok,frame_ok,"
                "close_seconds,sequence_ok,linkage_ok,accessible,wedged,result,note,photo_path,created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (task_id, door_id, user_id, int(fan_ok), int(frame_ok), close_seconds,
                 None if sequence_ok is None else int(bool(sequence_ok)),
                 None if linkage_ok is None else int(bool(linkage_ok)),
                 int(accessible), int(wedged), result, note, photo_path, self.iso()))
            insp_id = cur.lastrowid

            created_faults = []
            for ftype in faults_found:
                created_faults.append(self._open_fault(door_id, ftype, user_id,
                                                       note=FAULT_LABELS[ftype],
                                                       photo_path=photo_path))
            if faults_found:
                self._recompute_status(door_id)
            self._event("inspection",
                        f"门 {door['code']} 检查{'合格' if result == 'pass' else '发现 ' + '、'.join(FAULT_LABELS[f] for f in faults_found)}",
                        actor_id=user_id, entity_type="door_inspection", entity_id=insp_id,
                        door_id=door_id, data={"faults": faults_found})
            self.conn.commit()
            return {"inspection_id": insp_id, "result": result, "faults": created_faults}

    def finish_task(self, task_id: int, user_id: int) -> None:
        with self.lock:
            user = self.get_user(user_id)
            task = self.conn.execute("SELECT * FROM route_tasks WHERE id=?", (task_id,)).fetchone()
            if not task:
                raise ServiceError("巡检任务不存在")
            if task["assigned_to"] != user_id and user["role"] != "supervisor":
                raise ServiceError("只能完成分配给自己的巡检任务")
            if task["status"] != "in_progress":
                raise ServiceError("仅进行中的任务可以完成")
            route = self.conn.execute("SELECT * FROM inspection_routes WHERE id=?", (task["route_id"],)).fetchone()
            door_order = json.loads(route["door_order"])
            done = {r["door_id"] for r in self.conn.execute(
                "SELECT door_id FROM door_inspections WHERE task_id=?", (task_id,)).fetchall()}
            missing = [d for d in door_order if d not in done]
            if missing:
                raise ServiceError(f"路线尚有 {len(missing)} 扇门未检查，不能结束巡检")
            self.conn.execute("UPDATE route_tasks SET status='done', finished_at=? WHERE id=?",
                              (self.iso(), task_id))
            self.conn.execute("UPDATE reminders SET fired=1 WHERE ref_type='route_task' AND ref_id=?", (task_id,))
            self._event("inspection", f"巡检任务 {task['code']} 完成，步骤齐全",
                        actor_id=user_id, entity_type="route_task", entity_id=task_id)

    # ===== 故障 =====

    def _open_fault(self, door_id: int, fault_type: str, user_id: int, *,
                    note: str = "", related_fault_id: int | None = None,
                    photo_path: str | None = None) -> int:
        """打开故障；同类型活动故障已存在则复用（同一故障不重复登记/关闭）。调用方持锁。"""
        existing = self.conn.execute(
            "SELECT id, code FROM faults WHERE door_id=? AND fault_type=? AND status IN ('open','in_repair','resolved')"
            + (" AND related_fault_id IS ?" if related_fault_id is None
               else " AND related_fault_id=?")
            + " LIMIT 1",
            (door_id, fault_type, related_fault_id)).fetchone()
        if existing:
            self._event("fault", f"故障 {existing['code']}（{FAULT_LABELS[fault_type]}）再次被发现，沿用原单",
                        actor_id=user_id, entity_type="fault", entity_id=existing["id"], door_id=door_id)
            return existing["id"]
        count = self.conn.execute("SELECT COUNT(*) c FROM faults").fetchone()["c"] + 1
        code = f"FT-{self.now().strftime('%y%m')}-{count:04d}"
        cur = self.conn.execute(
            "INSERT INTO faults(code,door_id,fault_type,description,found_by,found_at,status,"
            "related_fault_id,photo_path) VALUES (?,?,?,?,?,?,'open',?,?)",
            (code, door_id, fault_type, note or FAULT_LABELS[fault_type], user_id,
             self.iso(), related_fault_id, photo_path))
        fid = cur.lastrowid
        self._event("fault", f"新建故障 {code}：{FAULT_LABELS[fault_type]}（门 {door_id}）",
                    actor_id=user_id, entity_type="fault", entity_id=fid, door_id=door_id)
        return fid

    # ===== 维修 =====

    def open_repair_order(self, fault_id: int, repairer_id: int, *, sla_hours: int = 24,
                          force: bool = False) -> int:
        """派单：同一门体同时只允许一张活动维修单。"""
        with self.lock:
            repairer = self.get_user(repairer_id)
            if repairer["role"] not in ("repairer", "supervisor"):
                raise ServiceError("只有维修工可以接单")
            fault = self.conn.execute("SELECT * FROM faults WHERE id=?", (fault_id,)).fetchone()
            if not fault:
                raise ServiceError("故障不存在")
            self._require_zone(repairer, self._door_zone(fault["door_id"]))
            if fault["status"] in ("resolved", "closed"):
                raise ServiceError("故障已进入复位/关闭流程，不能重新派单")
            occupied = self.conn.execute(
                "SELECT code FROM repair_orders WHERE door_id=? AND status IN ('open','in_progress','awaiting_reset')",
                (fault["door_id"],)).fetchone()
            if occupied and not force:
                raise ServiceError(f"门体已被维修单 {occupied['code']} 占用，不能同时开两张维修单")

            due = self.now() + timedelta(hours=sla_hours)
            count = self.conn.execute("SELECT COUNT(*) c FROM repair_orders").fetchone()["c"] + 1
            code = f"RO-{self.now().strftime('%y%m')}-{count:04d}"
            cur = self.conn.execute(
                "INSERT INTO repair_orders(code,fault_id,door_id,repairer_id,status,created_at,due_at)"
                " VALUES (?,?,?,?,'open',?,?)",
                (code, fault_id, fault["door_id"], repairer_id, self.iso(), self.iso(due)))
            oid = cur.lastrowid
            for key, label in REPAIR_STEP_TEMPLATES:
                self.conn.execute(
                    "INSERT INTO repair_steps(order_id,step_key,label) VALUES (?,?,?)",
                    (oid, key, label))
            self.conn.execute("UPDATE faults SET status='in_repair' WHERE id=?", (fault_id,))
            self.conn.execute(
                "INSERT OR IGNORE INTO reminders(kind,ref_type,ref_id,message,due_at,created_at)"
                " VALUES ('repair_due','repair_order',?,?,?,?)",
                (oid, f"维修单 {code} 即将到期/超时", self.iso(due - timedelta(hours=2)), self.iso()))
            self._recompute_status(fault["door_id"])
            self._event("repair", f"维修单 {code} 开工，占用门体；SLA 至 {self.iso(due)}",
                        actor_id=repairer_id, entity_type="repair_order", entity_id=oid,
                        door_id=fault["door_id"], data={"fault": fault["code"]})
            return oid

    def complete_step(self, order_id: int, step_key: str, user_id: int, note: str = "") -> None:
        with self.lock:
            user = self.get_user(user_id)
            order = self.conn.execute("SELECT * FROM repair_orders WHERE id=?", (order_id,)).fetchone()
            if not order:
                raise ServiceError("维修单不存在")
            if order["repairer_id"] != user_id and user["role"] != "supervisor":
                raise ServiceError("只有该单维修工可以登记步骤")
            if order["status"] not in ("open", "in_progress"):
                raise ServiceError("维修单当前状态不允许登记步骤")
            step = self.conn.execute(
                "SELECT * FROM repair_steps WHERE order_id=? AND step_key=?", (order_id, step_key)).fetchone()
            if not step:
                raise ServiceError("步骤不存在")
            if step["done"]:
                raise ServiceError("步骤已完成，不能重复登记")
            self.conn.execute(
                "UPDATE repair_steps SET done=1,done_at=?,done_by=?,note=? WHERE id=?",
                (self.iso(), user_id, note, step["id"]))
            if order["status"] == "open":
                self.conn.execute("UPDATE repair_orders SET status='in_progress',started_at=? WHERE id=?",
                                  (self.iso(), order_id))
            self._event("repair", f"维修单 {order['code']} 完成步骤：{step['label']}",
                        actor_id=user_id, entity_type="repair_step", entity_id=step["id"],
                        door_id=order["door_id"])

    def _missing_steps(self, order_id: int) -> list[str]:
        return [r["label"] for r in self.conn.execute(
            "SELECT label FROM repair_steps WHERE order_id=? AND required=1 AND done=0 ORDER BY id",
            (order_id,)).fetchall()]

    def complete_repair(self, order_id: int, user_id: int, note: str = "") -> None:
        """维修完成：所有必做步骤齐全才能提交，进入待复位。"""
        with self.lock:
            user = self.get_user(user_id)
            order = self.conn.execute("SELECT * FROM repair_orders WHERE id=?", (order_id,)).fetchone()
            if not order:
                raise ServiceError("维修单不存在")
            if order["repairer_id"] != user_id:
                raise ServiceError("只有该单维修工可以提交维修完成")
            if order["status"] not in ("open", "in_progress"):
                raise ServiceError("维修单不在可完成状态")
            missing = self._missing_steps(order_id)
            if missing:
                raise ServiceError("必做步骤未完成：" + "、".join(missing))
            self.conn.execute(
                "UPDATE repair_orders SET status='awaiting_reset', completed_at=?, note=? WHERE id=?",
                (self.iso(), note, order_id))
            self.conn.execute("UPDATE faults SET status='resolved' WHERE id=?", (order["fault_id"],))
            self.conn.execute(
                "INSERT OR IGNORE INTO reminders(kind,ref_type,ref_id,message,due_at,created_at)"
                " VALUES ('reset_due','repair_order',?,?,?,?)",
                (order_id, f"维修单 {order['code']} 待他人复位测试", self.iso(), self.iso()))
            self._event("repair", f"维修单 {order['code']} 维修完成，等待另一人复位测试",
                        actor_id=user_id, entity_type="repair_order", entity_id=order_id,
                        door_id=order["door_id"])

    # ===== 复位测试 =====

    def trigger_release(self, door_id: int, user_id: int) -> dict:
        """通过模拟适配器下发电磁释放，留信号日志。"""
        with self.lock:
            user = self.require_door_access(user_id, door_id)
            door = self.conn.execute("SELECT * FROM doors WHERE id=?", (door_id,)).fetchone()
            if not door["has_em_release"]:
                raise ServiceError("该门无电磁释放装置")
            res = self.adapter.release(door_id)
            self.conn.execute(
                "INSERT INTO release_signals(door_id,command,ok,response_ms,raw,created_at)"
                " VALUES (?,?,?,?,?,?)",
                (door_id, "release", int(res["ok"]), res["response_ms"], res["raw"], self.iso()))
            self.conn.commit()
            self._event("linkage",
                        f"电磁释放信号测试：{'回传正常' if res['ok'] else '信号无回传'}",
                        actor_id=user_id, entity_type="door", entity_id=door_id, door_id=door_id,
                        data=res)
            return res

    def _build_trace(self, close_seconds: float, secondary: float | None,
                     sequence_ok: bool | None) -> list[dict]:
        """由关闭用时生成 90°→0° 的时间刻度样本。"""
        def one(seconds: float, start_delay: float) -> list[list[float]]:
            samples: list[list[float]] = []
            steps = 10
            for i in range(steps + 1):
                t = round(start_delay + seconds * i / steps, 2)
                # 非线性：闭门器先快后慢（指数趋近）
                frac = 1 - (1 - i / steps) ** 1.7
                angle = round(90 * (1 - frac), 1)
                samples.append([t, angle])
            return samples

        traces = [{"leaf_label": "单扇" if secondary is None else "主动扇",
                   "samples": one(close_seconds, 0.0)}]
        if secondary is not None:
            # 顺序正确时从动扇先到位：delay 0 且略快；错误时从动扇反而滞后
            delay = 0.0 if sequence_ok else close_seconds * 0.35
            traces.append({"leaf_label": "从动扇", "samples": one(secondary, delay)})
        return traces

    def submit_reset_test(self, order_id: int, user_id: int, payload: dict) -> dict:
        """复位测试：测试项必须完整；测试人不得是维修人；全部合格才能恢复正常。"""
        with self.lock:
            user = self.get_user(user_id)
            order = self.conn.execute("SELECT * FROM repair_orders WHERE id=?", (order_id,)).fetchone()
            if not order:
                raise ServiceError("维修单不存在")
            self._require_zone(user, self._door_zone(order["door_id"]))

            # 职责分离：维修人不能通过自己的复位测试（连提交都不允许）
            if order["repairer_id"] == user_id:
                self._event("reset", f"维修单 {order['code']} 复位被拒：维修人不能测试自己的维修",
                            actor_id=user_id, entity_type="repair_order", entity_id=order_id,
                            door_id=order["door_id"])
                raise ServiceError("职责分离：复位测试必须由维修人以外的另一人执行")
            if order["status"] != "awaiting_reset":
                raise ServiceError("仅“待复位”状态的维修单可以执行复位测试")

            door = self.conn.execute("SELECT * FROM doors WHERE id=?", (order["door_id"],)).fetchone()

            # 测试项完整性校验
            required = ["fan_ok", "frame_ok", "close_seconds", "seal_ok"]
            missing = [k for k in required if payload.get(k) is None]
            if door["leaf_count"] == 2 and payload.get("sequence_ok") is None:
                missing.append("sequence_ok")
            if door["door_type"] == "normally_open" and payload.get("linkage_ok") is None:
                missing.append("linkage_ok")
            if missing:
                raise ServiceError("复位测试项不完整，缺少：" + "、".join(missing))

            fan_ok = bool(payload["fan_ok"])
            frame_ok = bool(payload["frame_ok"])
            seal_ok = bool(payload["seal_ok"])
            close_seconds = float(payload["close_seconds"])
            close_secondary = payload.get("close_seconds_secondary")
            if close_secondary is not None:
                close_secondary = float(close_secondary)
            sequence_ok = None if payload.get("sequence_ok") is None else bool(payload["sequence_ok"])
            linkage_ok = None if payload.get("linkage_ok") is None else bool(payload["linkage_ok"])

            fails: list[str] = []
            if not fan_ok:
                fails.append("门扇不合格")
            if not frame_ok:
                fails.append("门框不合格")
            lo, hi = RESET_PASS_WINDOW
            if not (lo <= close_seconds <= hi):
                fails.append(f"主动扇闭门速度 {close_seconds}s 超出 {lo:g}~{hi:g}s")
            if close_secondary is not None and not (lo <= close_secondary <= hi):
                fails.append(f"从动扇闭门速度 {close_secondary}s 超出区间")
            if door["leaf_count"] == 2 and not sequence_ok:
                fails.append("双扇顺序错误（从动扇未先于主动扇关严）")
            if door["door_type"] == "normally_open" and not linkage_ok:
                fails.append("电磁释放联动失败或信号无回传")
            if not seal_ok:
                fails.append("防火封堵不合格")

            result = "pass" if not fails else "fail"
            count = self.conn.execute("SELECT COUNT(*) c FROM reset_tests").fetchone()["c"] + 1
            code = f"RT-{self.now().strftime('%y%m')}-{count:04d}"
            cur = self.conn.execute(
                "INSERT INTO reset_tests(code,order_id,door_id,tester_id,fan_ok,frame_ok,"
                "close_seconds,close_seconds_secondary,sequence_ok,linkage_ok,seal_ok,result,"
                "fail_reasons,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (code, order_id, order["door_id"], user_id, int(fan_ok), int(frame_ok),
                 close_seconds, close_secondary,
                 None if sequence_ok is None else int(sequence_ok),
                 None if linkage_ok is None else int(linkage_ok),
                 int(seal_ok), result, json.dumps(fails, ensure_ascii=False),
                 payload.get("note", ""), self.iso()))
            reset_id = cur.lastrowid
            for tr in self._build_trace(close_seconds, close_secondary, sequence_ok):
                self.conn.execute(
                    "INSERT INTO reset_traces(reset_id,leaf_label,samples) VALUES (?,?,?)",
                    (reset_id, tr["leaf_label"], json.dumps(tr["samples"])))

            if result == "pass":
                self._pass_reset(order, door, reset_id, user_id, code)
            else:
                self._fail_reset(order, door, reset_id, user_id, code, fails)
            self.conn.commit()
            return {"reset_id": reset_id, "code": code, "result": result, "fail_reasons": fails}

    def _pass_reset(self, order: sqlite3.Row, door: sqlite3.Row,
                    reset_id: int, user_id: int, code: str) -> None:
        # 同一故障只能关闭一次（closed_at 仅置位一次）
        fault = self.conn.execute("SELECT * FROM faults WHERE id=?", (order["fault_id"],)).fetchone()
        if fault["closed_at"] is not None:
            raise ServiceError("该故障已关闭，同一故障不能重复关闭")
        self.conn.execute(
            "UPDATE repair_orders SET status='done', reset_at=? WHERE id=?",
            (self.iso(), order["id"]))
        self.conn.execute(
            "UPDATE faults SET status='closed', closed_at=?, closed_by=? WHERE id=?",
            (self.iso(), user_id, fault["id"]))
        # 关联的复位失败子单一并关闭
        self.conn.execute(
            "UPDATE faults SET status='closed', closed_at=?, closed_by=?"
            " WHERE related_fault_id=? AND status!='closed'",
            (self.iso(), user_id, fault["id"]))
        self.conn.execute("UPDATE reminders SET fired=1 WHERE ref_type='repair_order' AND ref_id=?",
                          (order["id"],))
        # 释放到期/有效的临时措施
        self.conn.execute(
            "UPDATE temp_measures SET status='released', released_at=?, released_by=?"
            " WHERE door_id=? AND status='active'",
            (self.iso(), user_id, door["id"]))
        self._event("reset", f"复位测试 {code} 全部合格，门 {door['code']} 恢复正常",
                    actor_id=user_id, entity_type="reset_test", entity_id=reset_id,
                    door_id=door["id"])
        self._recompute_status(door["id"])

    def _fail_reset(self, order: sqlite3.Row, door: sqlite3.Row,
                    reset_id: int, user_id: int, code: str, fails: list[str]) -> None:
        """复位退回：工单退回维修，挂 reset_failed 故障，全程留痕。"""
        self.conn.execute(
            "UPDATE repair_orders SET status='in_progress' WHERE id=?", (order["id"],))
        self.conn.execute("UPDATE faults SET status='in_repair' WHERE id=?", (order["fault_id"],))
        # 一次退回挂一张复位失败故障（按原故障去重）
        self._open_fault(door["id"], "reset_failed", user_id,
                         note="复位退回：" + "；".join(fails),
                         related_fault_id=order["fault_id"])
        # 退回后必做步骤需要重新自检
        self.conn.execute(
            "UPDATE repair_steps SET done=0,done_at=NULL,done_by=NULL,note=NULL"
            " WHERE order_id=? AND step_key IN ('speed','linkage','selfcheck')",
            (order["id"],))
        self._recompute_status(door["id"])
        self._event("reset", f"复位测试 {code} 不合格，退回维修：{'；'.join(fails)}",
                    actor_id=user_id, entity_type="reset_test", entity_id=reset_id,
                    door_id=door["id"], data={"fail_reasons": fails})

    def list_reset_tests(self, door_id: int | None = None) -> list[sqlite3.Row]:
        sql = ("SELECT r.*, o.code AS order_code, d.code AS door_code, u.name AS tester_name,"
               " (SELECT COUNT(*) FROM reset_traces t WHERE t.reset_id=r.id) AS trace_count"
               " FROM reset_tests r JOIN repair_orders o ON o.id=r.order_id"
               " JOIN doors d ON d.id=r.door_id LEFT JOIN users u ON u.id=r.tester_id")
        args: tuple = ()
        if door_id:
            sql += " WHERE r.door_id=?"
            args = (door_id,)
        sql += " ORDER BY r.created_at DESC"
        return self.conn.execute(sql, args).fetchall()

    def reset_detail(self, reset_id: int) -> dict:
        row = self.conn.execute(
            "SELECT r.*, o.code AS order_code, d.code AS door_code, u.name AS tester_name"
            " FROM reset_tests r JOIN repair_orders o ON o.id=r.order_id"
            " JOIN doors d ON d.id=r.door_id LEFT JOIN users u ON u.id=r.tester_id WHERE r.id=?",
            (reset_id,)).fetchone()
        if not row:
            raise ServiceError("复位记录不存在")
        traces = self.conn.execute("SELECT * FROM reset_traces WHERE reset_id=?", (reset_id,)).fetchall()
        return {"reset": row, "traces": traces}

    # ===== 临时措施（安全主管批准，有期限） =====

    def approve_temp_measure(self, door_id: int, user_id: int, reason: str,
                             hours: int = 24, fault_id: int | None = None) -> int:
        with self.lock:
            user = self.require_door_access(user_id, door_id)
            if user["role"] not in ROLE_CAN_TEMP_APPROVE:
                raise ServiceError("只有安全主管/经理可以批准临时措施")
            if hours <= 0 or hours > 168:
                raise ServiceError("临时措施期限需在 0~168 小时之间")
            door = self.conn.execute("SELECT * FROM doors WHERE id=?", (door_id,)).fetchone()
            if door["status"] == "decommissioned":
                raise ServiceError("停用门不适用临时措施")
            active = self.conn.execute(
                "SELECT id FROM temp_measures WHERE door_id=? AND status='active'", (door_id,)).fetchone()
            if active:
                raise ServiceError("该门已有生效中的临时措施")
            starts = self.now()
            expires = starts + timedelta(hours=hours)
            cur = self.conn.execute(
                "INSERT INTO temp_measures(door_id,fault_id,reason,approved_by,starts_at,expires_at,status)"
                " VALUES (?,?,?,?,?,?,'active')",
                (door_id, fault_id, reason, user_id, self.iso(starts), self.iso(expires)))
            mid = cur.lastrowid
            self.conn.execute(
                "INSERT OR IGNORE INTO reminders(kind,ref_type,ref_id,message,due_at,created_at)"
                " VALUES ('measure_expiring','temp_measure',?,?,?,?)",
                (mid, f"门 {door['code']} 临时措施即将到期", self.iso(expires - timedelta(hours=1)), self.iso()))
            self._recompute_status(door_id)
            self._event("measure", f"批准临时措施（至 {self.iso(expires)}）：{reason}",
                        actor_id=user_id, entity_type="temp_measure", entity_id=mid, door_id=door_id)
            return mid

    def release_temp_measure(self, measure_id: int, user_id: int) -> None:
        with self.lock:
            user = self.get_user(user_id)
            m = self.conn.execute("SELECT * FROM temp_measures WHERE id=?", (measure_id,)).fetchone()
            if not m:
                raise ServiceError("临时措施不存在")
            self._require_zone(user, self._door_zone(m["door_id"]))
            if m["status"] != "active":
                raise ServiceError("仅生效中的措施可以解除")
            self.conn.execute(
                "UPDATE temp_measures SET status='released',released_at=?,released_by=? WHERE id=?",
                (self.iso(), user_id, measure_id))
            self._recompute_status(m["door_id"])
            self._event("measure", "临时措施提前解除", actor_id=user_id,
                        entity_type="temp_measure", entity_id=measure_id, door_id=m["door_id"])

    def expire_measures(self) -> int:
        """到期扫描：过期的 active 措施置 expired 并重新推导门态。"""
        n = 0
        with self.lock:
            rows = self.conn.execute(
                "SELECT * FROM temp_measures WHERE status='active' AND expires_at<=?",
                (self.iso(),)).fetchall()
            for m in rows:
                self.conn.execute("UPDATE temp_measures SET status='expired' WHERE id=?", (m["id"],))
                self.conn.execute("UPDATE reminders SET fired=1 WHERE ref_type='temp_measure' AND ref_id=?",
                                  (m["id"],))
                self._recompute_status(m["door_id"])
                self._event("measure", "临时措施到期，自动失效，门体回到待维修管控",
                            entity_type="temp_measure", entity_id=m["id"], door_id=m["door_id"],
                            data={"expires_at": m["expires_at"]})
                n += 1
        return n

    # ===== 停用标记 =====

    def set_decommission(self, door_id: int, user_id: int, reason: str, active: bool) -> None:
        with self.lock:
            user = self.require_door_access(user_id, door_id)
            if user["role"] not in ROLE_CAN_DECOMMISSION:
                raise ServiceError("只有安全主管/经理可以停用/启用门体")
            if active:
                occupied = self.conn.execute(
                    "SELECT code FROM repair_orders WHERE door_id=? AND status IN ('open','in_progress','awaiting_reset')",
                    (door_id,)).fetchone()
                if occupied:
                    raise ServiceError(f"门体被维修单 {occupied['code']} 占用，不能停用")
                self.conn.execute(
                    "UPDATE doors SET status='decommissioned', decommission_reason=?, updated_at=? WHERE id=?",
                    (reason, self.iso(), door_id))
                self._event("door", f"门体停用：{reason}", actor_id=user_id,
                            entity_type="door", entity_id=door_id, door_id=door_id)
            else:
                self.conn.execute(
                    "UPDATE doors SET status='normal', decommission_reason=NULL, updated_at=? WHERE id=?",
                    (self.iso(), door_id))
                self._event("door", "门体停用标记解除", actor_id=user_id,
                            entity_type="door", entity_id=door_id, door_id=door_id)
                self._recompute_status(door_id)

    # ===== 维修超时 =====

    def sweep_repair_timeouts(self) -> int:
        """超过 SLA 仍未完成复位的工单：记维修超时故障并提醒。"""
        n = 0
        with self.lock:
            rows = self.conn.execute(
                "SELECT * FROM repair_orders WHERE status IN ('open','in_progress','awaiting_reset')"
                " AND due_at<=? AND timeout_fired=0", (self.iso(),)).fetchall()
            for o in rows:
                self.conn.execute("UPDATE repair_orders SET timeout_fired=1 WHERE id=?", (o["id"],))
                fid = self._open_fault(o["door_id"], "repair_timeout", o["repairer_id"],
                                       note=f"维修单 {o['code']} 超过 SLA（{o['due_at']}）")
                self.conn.execute(
                    "INSERT OR IGNORE INTO reminders(kind,ref_type,ref_id,message,due_at,created_at)"
                    " VALUES ('repair_overdue','repair_order',?,?,?,?)",
                    (o["id"], f"维修单 {o['code']} 已超时", self.iso(), self.iso()))
                self._recompute_status(o["door_id"])
                n += 1
        return n

    # ===== 逾期统计 =====

    def overdue_stats(self) -> dict:
        now = self.iso()
        ins_overdue = self.conn.execute(
            "SELECT t.*, r.name route_name FROM route_tasks t JOIN inspection_routes r ON r.id=t.route_id"
            " WHERE t.status IN ('pending','in_progress') AND t.due_at<?", (now,)).fetchall()
        repair_overdue = self.conn.execute(
            "SELECT o.*, d.code door_code, u.name repairer_name FROM repair_orders o"
            " JOIN doors d ON d.id=o.door_id LEFT JOIN users u ON u.id=o.repairer_id"
            " WHERE o.status IN ('open','in_progress','awaiting_reset') AND o.due_at<?",
            (now,)).fetchall()
        measures_expired = self.conn.execute(
            "SELECT m.*, d.code door_code FROM temp_measures m JOIN doors d ON d.id=m.door_id"
            " WHERE m.status IN ('active','expired') AND m.expires_at<?", (now,)).fetchall()
        active_measures = self.conn.execute(
            "SELECT COUNT(*) c FROM temp_measures WHERE status='active'").fetchone()["c"]
        by_type = {r["fault_type"]: r["c"] for r in self.conn.execute(
            "SELECT fault_type, COUNT(*) c FROM faults WHERE status!='closed' GROUP BY fault_type")}
        return {
            "generated_at": now,
            "inspection_overdue": ins_overdue,
            "repair_overdue": repair_overdue,
            "measures_expired": measures_expired,
            "counts": {
                "inspection_overdue": len(ins_overdue),
                "repair_overdue": len(repair_overdue),
                "measures_expired": len(measures_expired),
                "active_measures": active_measures,
            },
            "open_faults_by_type": by_type,
        }

    # ===== 照片 =====

    def save_photo(self, door_id: int, user_id: int, data_b64: str, suffix: str = "jpg") -> str:
        import base64, re
        user = self.require_door_access(user_id, door_id)
        raw = re.sub(r"^data:image/\w+;base64,", "", data_b64)
        blob = base64.b64decode(raw)
        fname = f"door_{door_id}_{self.now().strftime('%Y%m%d%H%M%S')}_{user_id}.{suffix}"
        p = self.photo_dir / fname
        p.write_bytes(blob)
        self._event("photo", f"上传门体照片 {fname}", actor_id=user_id,
                    entity_type="door", entity_id=door_id, door_id=door_id)
        return str(Path("data/photos") / fname)
