"""演示数据与样例事件。

设备数据（楼栋/分区/门体/部件/路线）为演示内容；
样例包含：楔门（FM-101）、联动失败（FM-203）、复位退回（FM-102），
以及维修超时（FM-105）与临时措施到期（FM-106）的逾期素材。
"""
from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

from .service import REPAIR_STEP_TEMPLATES, FireDoorService

# 模拟适配器中“联动失败、信号无回传”的门
FAIL_RELEASE_DOOR_CODES = ["FM-203"]

# ---------- 设备台账 ----------

BUILDINGS = [
    ("云栖苑·1号住宅楼", "江州市槐荫区云栖路 88 号"),
    ("云栖苑·2号商住楼", "江州市槐荫区云栖路 90 号"),
]

# (code, building_idx, name, floor, polygon)
ZONES = [
    ("FZ-101", 0, "1号楼一层东防火分区", "F1",
     [[4, 52], [60, 52], [60, 96], [4, 96]]),
    ("FZ-102", 0, "1号楼一层西防火分区", "F1",
     [[64, 52], [96, 52], [96, 96], [64, 96]]),
    ("FZ-201", 0, "1号楼二层防火分区", "F2",
     [[6, 8], [94, 8], [94, 44], [6, 44]]),
    ("FZ-301", 1, "2号楼一层防火分区", "F1",
     [[4, 50], [58, 50], [58, 96], [4, 96]]),
    ("FZ-302", 1, "2号楼二层防火分区", "F2",
     [[62, 50], [96, 50], [96, 96], [62, 96]]),
]

# code, zone_idx, location, type, leaves, em, x, y, angle, seal
DOORS = [
    ("FM-101", 0, "一层东楼梯间入口", "normally_closed", 1, 0, 18, 94, 0, "intact"),
    ("FM-102", 0, "一层东走廊前室", "normally_closed", 2, 0, 44, 70, 90, "intact"),
    ("FM-103", 0, "一层东管井通道", "normally_closed", 1, 0, 8, 60, 0, "intact"),
    ("FM-104", 1, "一层西大堂连廊", "normally_open", 2, 1, 80, 94, 0, "intact"),
    ("FM-105", 1, "一层西电房前", "normally_closed", 1, 0, 92, 72, 90, "intact"),
    ("FM-106", 1, "一层西货梯厅", "normally_closed", 1, 0, 68, 56, 0, "deficient"),
    ("FM-201", 2, "二层合用前室", "normally_open", 1, 1, 20, 42, 0, "intact"),
    ("FM-202", 2, "二层走廊隔断（双扇）", "normally_closed", 2, 0, 50, 22, 90, "intact"),
    ("FM-203", 2, "二层疏散走道连廊", "normally_open", 2, 1, 82, 42, 0, "intact"),
    ("FM-301", 3, "2号楼一层商铺后通道", "normally_closed", 1, 0, 16, 94, 0, "intact"),
    ("FM-302", 3, "2号楼一层前室", "normally_open", 1, 1, 42, 70, 90, "intact"),
    ("FM-303", 3, "2号楼一层楼梯间（双扇）", "normally_closed", 2, 0, 8, 54, 0, "intact"),
    ("FM-401", 4, "2号楼二层办公区入口", "normally_closed", 1, 0, 72, 94, 0, "intact"),
    ("FM-402", 4, "2号楼二层电井门", "normally_closed", 1, 0, 92, 70, 90, "intact"),
]

# name, role, zone_scope('*' 或 zone code 列表)
USERS = [
    ("王巡", "inspector", "*"),
    ("李检", "inspector", "FZ-301"),       # 仅 2号楼一层权限，用于验证区域权限
    ("赵修", "repairer", "*"),
    ("钱修", "repairer", "*"),             # 第二维修人：复位测试由他执行
    ("孙主管", "supervisor", "*"),
    ("周经理", "manager", "*"),
]

# (route name, [door codes...])
ROUTES = [
    ("1号楼一层日间巡检", ["FM-101", "FM-102", "FM-103", "FM-104", "FM-105", "FM-106"]),
    ("1号楼二层日间巡检", ["FM-201", "FM-202", "FM-203"]),
    ("2号楼全日巡检", ["FM-301", "FM-302", "FM-303", "FM-401", "FM-402"]),
]

CLOSER_MODELS = {
    1: [("FS-CL68", "主动扇")],
    2: [("FS-CL68", "主动扇"), ("FS-CL68", "从动扇")],
}


def _placeholder_svg(code: str, label: str) -> bytes:
    return f"""<svg xmlns='http://www.w3.org/2000/svg' width='320' height='220'>
<rect width='320' height='220' fill='#efece7'/>
<rect x='10' y='10' width='300' height='200' fill='none' stroke='#3a3f44' stroke-width='2' stroke-dasharray='6 4'/>
<rect x='70' y='50' width='120' height='140' fill='#d9d4cc' stroke='#3a3f44' stroke-width='2'/>
<rect x='190' y='50' width='60' height='140' fill='#cfc8be' stroke='#3a3f44' stroke-width='2'/>
<circle cx='182' cy='122' r='5' fill='#c0392b'/>
<text x='160' y='34' font-family='sans-serif' font-size='20' fill='#2d3135' text-anchor='middle'>{code} 现场照片</text>
<text x='160' y='212' font-family='sans-serif' font-size='13' fill='#6a6f75' text-anchor='middle'>{label}（演示占位图）</text>
</svg>""".encode()


# ---------- 构建 ----------

def build_demo(svc: FireDoorService, with_samples: bool = True) -> None:
    conn = svc.conn
    iso = svc.iso()

    building_ids, zone_ids, door_ids = [], [], {}
    for name, addr in BUILDINGS:
        cur = conn.execute("INSERT INTO buildings(name,address) VALUES (?,?)", (name, addr))
        building_ids.append(cur.lastrowid)
    for code, bi, name, floor, poly in ZONES:
        cur = conn.execute(
            "INSERT INTO fire_zones(building_id,code,name,floor,polygon) VALUES (?,?,?,?,?)",
            (building_ids[bi], code, name, floor, json.dumps(poly)))
        zone_ids.append(cur.lastrowid)
    for code, zi, loc, dtype, leaves, em, x, y, ang, seal in DOORS:
        cur = conn.execute(
            "INSERT INTO doors(zone_id,code,location,door_type,leaf_count,status,seal_status,"
            "has_em_release,map_x,map_y,map_angle,created_at,updated_at)"
            " VALUES (?,?,?,?,?,'normal',?,?,?,?,?,?,?)",
            (zone_ids[zi], code, loc, dtype, leaves, seal, em, x, y, ang, iso, iso))
        did = cur.lastrowid
        door_ids[code] = did
        for model, leaf_label in CLOSER_MODELS[leaves]:
            conn.execute(
                "INSERT INTO door_components(door_id,kind,leaf_label,model,serial,status,installed_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (did, "closer", leaf_label, model, f"SN-{code}-C{leaf_label or 'X'}", "ok", iso))
        if leaves == 2:
            conn.execute(
                "INSERT INTO door_components(door_id,kind,leaf_label,model,serial,status,installed_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (did, "sequencer", "", "FS-SQ22", f"SN-{code}-S", "ok", iso))
        if em:
            conn.execute(
                "INSERT INTO door_components(door_id,kind,leaf_label,model,serial,status,installed_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (did, "em_release", "", "FS-EM01", f"SN-{code}-E", "ok", iso))

    code_to_zone = {z[0]: zone_ids[i] for i, z in enumerate(ZONES)}
    user_ids = []
    for name, role, scope in USERS:
        scope_value = scope if scope == "*" else ",".join(
            str(code_to_zone[c]) for c in scope.split(","))
        cur = conn.execute(
            "INSERT INTO users(name,role,zone_scope) VALUES (?,?,?)", (name, role, scope_value))
        user_ids.append(cur.lastrowid)
    U_INS, U_INS2, U_REP, U_REP2, U_SUP, U_MGR = user_ids

    route_ids = []
    for name, codes in ROUTES:
        cur = conn.execute(
            "INSERT INTO inspection_routes(name,zone_ids,door_order,frequency) VALUES (?,?,?,?)",
            (name, "",
             json.dumps([door_ids[c] for c in codes]), "daily"))
        route_ids.append(cur.lastrowid)
    conn.commit()

    if with_samples:
        _build_samples(svc, door_ids, user_ids, route_ids)


def _build_samples(svc: FireDoorService, doors: dict[str, int], users: list[int], routes: list[int]) -> None:
    U_INS, U_INS2, U_REP, U_REP2, U_SUP, U_MGR = users

    # 当日巡检任务（路线1，样例会用到）
    n = svc.generate_route_tasks()
    task_today = svc.conn.execute(
        "SELECT id FROM route_tasks WHERE route_id=? ORDER BY id DESC LIMIT 1", (routes[0],)).fetchone()["id"]
    svc.start_task(task_today, U_INS)

    # 照片占位图
    photo_dir = svc.photo_dir
    p1 = photo_dir / "FM-101_wedge_demo.svg"
    p1.write_bytes(_placeholder_svg("FM-101", "门扇下沿发现木楔"))
    rel_photo = "data/photos/FM-101_wedge_demo.svg"

    # —— 样例 1：FM-101 门体被楔开 ——
    svc.submit_door_inspection(task_today, doors["FM-101"], U_INS, {
        "fan_ok": True, "frame_ok": True, "close_seconds": 6.0,
        "accessible": True, "wedged": True,
        "note": "门扇下方发现木楔，防火门被人为固定常开",
        "photo_path": rel_photo})

    # —— 样例 2：FM-203 电磁释放联动失败、信号无回传 ——
    task_route2 = _route_task(svc, routes[1])
    svc.submit_door_inspection(task_route2, doors["FM-203"], U_INS, {
        "fan_ok": True, "frame_ok": True, "close_seconds": 5.4,
        "sequence_ok": True, "linkage_ok": False, "accessible": True,
        "note": "消控室下发释放指令后，门体未动作，模块无回传信号"})
    svc.trigger_release(doors["FM-203"], U_INS)  # 适配器对该门返回失败
    fault_link = svc.conn.execute(
        "SELECT id FROM faults WHERE door_id=? AND fault_type='no_signal' AND status!='closed'",
        (doors["FM-203"],)).fetchone()["id"]
    oid_link = svc.open_repair_order(fault_link, U_REP, sla_hours=12)
    svc.complete_step(oid_link, "scene", U_REP, "已现场警戒，排查联动线路")

    # —— 样例 3：FM-102 维修完成 → 另一人复位测试失败 → 退回 ——
    svc.submit_door_inspection(task_today, doors["FM-102"], U_INS, {
        "fan_ok": True, "frame_ok": True, "close_seconds": 5.8,
        "sequence_ok": True, "accessible": True, "wedged": True,
        "note": "双扇前室门被楔开"})
    fault_w = svc.conn.execute(
        "SELECT id FROM faults WHERE door_id=? AND fault_type='wedged' AND related_fault_id IS NULL",
        (doors["FM-102"],)).fetchone()["id"]
    oid = svc.open_repair_order(fault_w, U_REP, sla_hours=24)
    for key, _ in REPAIR_STEP_TEMPLATES:
        svc.complete_step(oid, key, U_REP, "样例：步骤完成")
    svc.complete_repair(oid, U_REP, "木楔已移除，闭门速度重新调校")
    # 由另一名维修工钱修执行复位：闭门过快 + 双扇顺序错误 → 退回
    svc.submit_reset_test(oid, U_REP2, {
        "fan_ok": True, "frame_ok": True, "close_seconds": 2.2,
        "close_seconds_secondary": 4.6, "sequence_ok": False,
        "linkage_ok": None, "seal_ok": True,
        "note": "复位测试：从动扇滞后于主动扇，且主动扇 2.2s 撞击门框"})

    # —— 逾期素材 A：FM-105 维修单 SLA 已过（首次调度扫描会登记维修超时）——
    svc.submit_door_inspection(task_today, doors["FM-105"], U_INS, {
        "fan_ok": True, "frame_ok": True, "close_seconds": 1.8,
        "accessible": True, "note": "闭门猛烈撞击，疑似调速阀失效"})
    fault_fast = svc.conn.execute(
        "SELECT id FROM faults WHERE door_id=? AND fault_type='closing_too_fast'",
        (doors["FM-105"],)).fetchone()["id"]
    oid_overdue = svc.open_repair_order(fault_fast, U_REP, sla_hours=24)
    past = svc.iso(svc.now() - timedelta(hours=5))
    svc.conn.execute("UPDATE repair_orders SET due_at=?, created_at=? WHERE id=?",
                     (past, past, oid_overdue))
    svc.conn.execute("UPDATE faults SET found_at=? WHERE id=?", (past, fault_fast))
    svc.conn.commit()

    # —— 逾期素材 B：FM-106 临时措施已过期（挂在封堵缺陷故障下，到期回到待维修）——
    fault_seal = svc._open_fault(doors["FM-106"], "seal_deficient", U_INS,
                                 note="门框与墙体间封堵缝隙不满足耐火极限")
    mid = svc.approve_temp_measure(doors["FM-106"], U_SUP,
                                   "封堵缝隙不满足耐火极限，先临时封控并安排材料",
                                   hours=8, fault_id=fault_seal)
    expired = svc.iso(svc.now() - timedelta(hours=2))
    svc.conn.execute("UPDATE temp_measures SET starts_at=?, expires_at=? WHERE id=?",
                     (svc.iso(svc.now() - timedelta(hours=10)), expired, mid))
    svc.conn.commit()

    # —— 逾期素材 C：2号楼一条巡检任务昨天到期未完成 ——
    code_y = f"IT-{routes[2]}-YDAY"
    due_y = svc.iso(svc.now() - timedelta(days=1))
    svc.conn.execute(
        "INSERT INTO route_tasks(code,route_id,assigned_to,due_at,status,created_at)"
        " VALUES (?,?,?,?,'pending',?)",
        (code_y, routes[2], U_INS, due_y, due_y))
    svc.conn.execute(
        "INSERT OR IGNORE INTO reminders(kind,ref_type,ref_id,message,due_at,created_at)"
        " VALUES ('inspection_due','route_task',(SELECT id FROM route_tasks WHERE code=?),"
        " '昨日巡检任务逾期未执行',?,?)",
        (code_y, due_y, due_y))
    svc.conn.commit()

    # 立即跑一次到期扫描：维修超时、临时措施到期分别留痕
    svc.sweep_repair_timeouts()
    svc.expire_measures()


def _route_task(svc: FireDoorService, route_id: int) -> int:
    """取某路线当日任务，没有则补建并开始。"""
    row = svc.conn.execute(
        "SELECT id FROM route_tasks WHERE route_id=? ORDER BY id DESC LIMIT 1",
        (route_id,)).fetchone()
    if row:
        return row["id"]
    svc.generate_route_tasks()
    tid = svc.conn.execute(
        "SELECT id FROM route_tasks WHERE route_id=? ORDER BY id DESC LIMIT 1",
        (route_id,)).fetchone()["id"]
    assignee = svc.conn.execute("SELECT assigned_to FROM route_tasks WHERE id=?", (tid,)).fetchone()["assigned_to"]
    svc.start_task(tid, assignee)
    return tid
