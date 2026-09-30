"""业务规则测试：工单唯一、步骤完整、职责分离、临时措施到期、区域权限，以及样例数据留痕。

运行：python3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from firedoor.demo import build_demo
from firedoor.service import (REPAIR_STEP_TEMPLATES, FireDoorService,
                              ReleaseAdapter, ServiceError)


def make_service(with_samples: bool = True) -> FireDoorService:
    tmp = tempfile.mkdtemp(prefix="firedoor-test-")
    svc = FireDoorService(db_path=Path(tmp) / "test.db",
                          photo_dir=Path(tmp) / "photos")
    if with_samples:
        build_demo(svc, with_samples=False)
        rows = svc.conn.execute("SELECT id FROM doors WHERE code='FM-203'").fetchall()
        svc.adapter = ReleaseAdapter(fail_doors=[r["id"] for r in rows])
        from firedoor.demo import _build_samples
        doors = {r["code"]: r["id"] for r in svc.conn.execute("SELECT id,code FROM doors")}
        users = [r["id"] for r in svc.conn.execute("SELECT id FROM users ORDER BY id")]
        routes = [r["id"] for r in svc.conn.execute("SELECT id FROM inspection_routes ORDER BY id")]
        _build_samples(svc, doors, users, routes)
    else:
        build_demo(svc, with_samples=False)
    return svc


class DemoDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.svc = make_service(True)

    def test_device_seed(self) -> None:
        c = self.svc.conn
        self.assertEqual(c.execute("SELECT COUNT(*) FROM buildings").fetchone()[0], 2)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM fire_zones").fetchone()[0], 5)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM doors").fetchone()[0], 14)
        # 双扇门具备顺序器，常开门具备电磁释放
        self.assertEqual(c.execute(
            "SELECT COUNT(*) FROM door_components WHERE kind='sequencer'").fetchone()[0], 5)
        self.assertEqual(c.execute(
            "SELECT COUNT(*) FROM door_components WHERE kind='em_release'").fetchone()[0], 4)

    def test_samples_recorded(self) -> None:
        """楔门、联动失败、复位退回、维修超时、措施到期分别留痕。"""
        c = self.svc.conn
        types = {r["fault_type"] for r in c.execute(
            "SELECT DISTINCT fault_type FROM faults")}
        for t in ("wedged", "no_signal", "reset_failed",
                  "closing_too_fast", "repair_timeout", "seal_deficient"):
            self.assertIn(t, types, f"缺少样例故障类型 {t}")
        # FM-203 适配器失败并记录信号日志
        sig = c.execute(
            "SELECT s.ok FROM release_signals s JOIN doors d ON d.id=s.door_id"
            " WHERE d.code='FM-203' ORDER BY s.id").fetchall()
        self.assertTrue(sig and sig[-1]["ok"] == 0)
        # FM-102 的复位失败挂在原故障下，工单被退回维修中
        row = c.execute(
            "SELECT o.status FROM repair_orders o JOIN doors d ON d.id=o.door_id"
            " WHERE d.code='FM-102'").fetchone()
        self.assertEqual(row["status"], "in_progress")
        # 临时措施已过期，门回到待维修
        self.assertEqual(c.execute(
            "SELECT status FROM doors WHERE code='FM-106'").fetchone()["status"],
            "pending_repair")
        # 全程事件留痕覆盖各类别
        cats = {r["category"] for r in c.execute("SELECT DISTINCT category FROM events")}
        self.assertTrue({"inspection", "fault", "repair", "reset", "measure", "linkage"} <= cats)


class WorkOrderUniquenessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.svc = make_service(False)
        c = self.svc.conn
        self.u_ins = c.execute("SELECT id FROM users WHERE name='王巡'").fetchone()["id"]
        self.u_rep = c.execute("SELECT id FROM users WHERE name='赵修'").fetchone()["id"]
        self.u_rep2 = c.execute("SELECT id FROM users WHERE name='钱修'").fetchone()["id"]
        self.door = c.execute("SELECT id FROM doors WHERE code='FM-103'").fetchone()["id"]
        self.route = c.execute("SELECT id FROM inspection_routes LIMIT 1").fetchone()["id"]

    def _open_wedged_fault(self) -> int:
        svc = self.svc
        svc.generate_route_tasks()
        tid = svc.conn.execute(
            "SELECT id FROM route_tasks WHERE route_id=? ORDER BY id LIMIT 1",
            (self.route,)).fetchone()["id"]
        svc.start_task(tid, self.u_ins)
        svc.submit_door_inspection(tid, self.door, self.u_ins, {
            "fan_ok": True, "frame_ok": True, "close_seconds": 6.0,
            "accessible": True, "wedged": True})
        return svc.conn.execute(
            "SELECT id FROM faults WHERE door_id=? AND fault_type='wedged' AND status='open'",
            (self.door,)).fetchone()["id"]

    def test_two_orders_cannot_share_door(self) -> None:
        fid = self._open_wedged_fault()
        self.svc.open_repair_order(fid, self.u_rep)
        with self.assertRaisesRegex(ServiceError, "不能同时开两张维修单"):
            self.svc.open_repair_order(fid, self.u_rep2)
        # 数据库层面也有唯一部分索引兜底
        import sqlite3
        with self.assertRaises(sqlite3.IntegrityError):
            self.svc.conn.execute(
                "INSERT INTO repair_orders(code,fault_id,door_id,repairer_id,status,created_at,due_at)"
                " VALUES ('X-1',?,?,?,'open',?,?)",
                (fid, self.door, self.u_rep2, self.svc.iso(), self.svc.iso()))

    def test_same_fault_closed_once(self) -> None:
        fid = self._open_wedged_fault()
        oid = self.svc.open_repair_order(fid, self.u_rep)
        for key, _ in REPAIR_STEP_TEMPLATES:
            self.svc.complete_step(oid, key, self.u_rep)
        self.svc.complete_repair(oid, self.u_rep)
        before = self.svc.conn.execute(
            "SELECT closed_at FROM faults WHERE id=?", (fid,)).fetchone()["closed_at"]
        self.assertIsNone(before)
        self.svc.submit_reset_test(oid, self.u_rep2, {
            "fan_ok": True, "frame_ok": True, "seal_ok": True, "close_seconds": 5.0})
        after = self.svc.conn.execute(
            "SELECT closed_at,status FROM faults WHERE id=?", (fid,)).fetchone()
        self.assertIsNotNone(after["closed_at"])
        self.assertEqual(after["status"], "closed")
        # 已关闭故障不能再派单（同一故障不会被第二次关闭）
        with self.assertRaisesRegex(ServiceError, "已进入复位/关闭流程"):
            self.svc.open_repair_order(fid, self.u_rep)
        # 门体恢复正常
        self.assertEqual(self.svc.conn.execute(
            "SELECT status FROM doors WHERE id=?", (self.door,)).fetchone()["status"], "normal")

    def test_duplicate_fault_reuses_open_ticket(self) -> None:
        """同类型活动故障重复发现时沿用原单，不重复建单。"""
        self._open_wedged_fault()
        tid = self.svc.conn.execute(
            "SELECT id FROM route_tasks WHERE route_id=? ORDER BY id LIMIT 1",
            (self.route,)).fetchone()["id"]
        self.svc.submit_door_inspection(tid, self.door, self.u_ins, {
            "fan_ok": True, "frame_ok": True, "close_seconds": 6.0,
            "accessible": True, "wedged": True})
        n = self.svc.conn.execute(
            "SELECT COUNT(*) c FROM faults WHERE door_id=? AND fault_type='wedged'"
            " AND related_fault_id IS NULL", (self.door,)).fetchone()["c"]
        self.assertEqual(n, 1)


class RepairStepsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.svc = make_service(False)
        c = self.svc.conn
        self.u_rep = c.execute("SELECT id FROM users WHERE name='赵修'").fetchone()["id"]
        self.oid, self.door = self._order_with_wedge()

    def _order_with_wedge(self) -> tuple[int, int]:
        svc = self.svc
        u_ins = svc.conn.execute("SELECT id FROM users WHERE name='王巡'").fetchone()["id"]
        door = svc.conn.execute("SELECT id FROM doors WHERE code='FM-103'").fetchone()["id"]
        route = svc.conn.execute("SELECT id FROM inspection_routes LIMIT 1").fetchone()["id"]
        svc.generate_route_tasks()
        tid = svc.conn.execute(
            "SELECT id FROM route_tasks ORDER BY id LIMIT 1").fetchone()["id"]
        svc.start_task(tid, u_ins)
        svc.submit_door_inspection(tid, door, u_ins, {
            "fan_ok": True, "frame_ok": True, "close_seconds": 6.0,
            "accessible": True, "wedged": True})
        fid = svc.conn.execute(
            "SELECT id FROM faults WHERE door_id=? AND status='open'", (door,)).fetchone()["id"]
        return svc.open_repair_order(fid, self.u_rep), door

    def test_cannot_complete_without_all_steps(self) -> None:
        with self.assertRaisesRegex(ServiceError, "必做步骤未完成"):
            self.svc.complete_repair(self.oid, self.u_rep)
        for key, _ in REPAIR_STEP_TEMPLATES[:-1]:
            self.svc.complete_step(self.oid, key, self.u_rep)
        with self.assertRaises(ServiceError):
            self.svc.complete_repair(self.oid, self.u_rep)
        self.svc.complete_step(self.oid, REPAIR_STEP_TEMPLATES[-1][0], self.u_rep)
        self.svc.complete_repair(self.oid, self.u_rep)
        self.assertEqual(self.svc.conn.execute(
            "SELECT status FROM repair_orders WHERE id=?", (self.oid,)).fetchone()["status"],
            "awaiting_reset")

    def test_step_cannot_be_done_twice(self) -> None:
        self.svc.complete_step(self.oid, "scene", self.u_rep)
        with self.assertRaisesRegex(ServiceError, "不能重复登记"):
            self.svc.complete_step(self.oid, "scene", self.u_rep)

    def test_route_finish_requires_every_door(self) -> None:
        """路线步骤完整性：漏检门不能结束巡检。"""
        svc = self.svc
        u_ins = svc.conn.execute("SELECT id FROM users WHERE name='王巡'").fetchone()["id"]
        tid = svc.conn.execute("SELECT id FROM route_tasks ORDER BY id LIMIT 1").fetchone()["id"]
        with self.assertRaisesRegex(ServiceError, "扇门未检查"):
            svc.finish_task(tid, u_ins)


class DutySegregationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.svc = make_service(False)
        c = self.svc.conn
        self.u_ins = c.execute("SELECT id FROM users WHERE name='王巡'").fetchone()["id"]
        self.u_rep = c.execute("SELECT id FROM users WHERE name='赵修'").fetchone()["id"]
        self.u_rep2 = c.execute("SELECT id FROM users WHERE name='钱修'").fetchone()["id"]

    def _ready_order(self, code: str = "FM-103") -> int:
        svc = self.svc
        door = svc.conn.execute("SELECT id FROM doors WHERE code=?", (code,)).fetchone()["id"]
        svc.generate_route_tasks()
        tid = svc.conn.execute("SELECT id FROM route_tasks ORDER BY id LIMIT 1").fetchone()["id"]
        svc.start_task(tid, self.u_ins)
        svc.submit_door_inspection(tid, door, self.u_ins, {
            "fan_ok": True, "frame_ok": True, "close_seconds": 6.0,
            "accessible": True, "wedged": True})
        fid = svc.conn.execute(
            "SELECT id FROM faults WHERE door_id=? AND status='open'", (door,)).fetchone()["id"]
        oid = svc.open_repair_order(fid, self.u_rep)
        for key, _ in REPAIR_STEP_TEMPLATES:
            svc.complete_step(oid, key, self.u_rep)
        svc.complete_repair(oid, self.u_rep)
        return oid

    def test_repairer_cannot_reset_own_work(self) -> None:
        oid = self._ready_order()
        with self.assertRaisesRegex(ServiceError, "职责分离"):
            self.svc.submit_reset_test(oid, self.u_rep, {
                "fan_ok": True, "frame_ok": True, "seal_ok": True, "close_seconds": 5.0})

    def test_other_person_resets_and_restores(self) -> None:
        oid = self._ready_order()
        res = self.svc.submit_reset_test(oid, self.u_rep2, {
            "fan_ok": True, "frame_ok": True, "seal_ok": True, "close_seconds": 5.5})
        self.assertEqual(res["result"], "pass")

    def test_reset_failure_rejects_and_requires_rework(self) -> None:
        """复位不合格：退回维修，挂 reset_failed 故障，关键步骤需重做。"""
        svc = self.svc
        oid = self._ready_order("FM-102")  # 双扇门
        res = svc.submit_reset_test(oid, self.u_rep2, {
            "fan_ok": True, "frame_ok": True, "seal_ok": True,
            "close_seconds": 2.2, "close_seconds_secondary": 4.8,
            "sequence_ok": False})
        self.assertEqual(res["result"], "fail")
        self.assertTrue(any("闭门速度" in r for r in res["fail_reasons"]))
        self.assertTrue(any("顺序" in r for r in res["fail_reasons"]))
        # 工单退回、复位失败留痕、轨迹生成
        self.assertEqual(svc.conn.execute(
            "SELECT status FROM repair_orders WHERE id=?", (oid,)).fetchone()["status"],
            "in_progress")
        self.assertTrue(svc.conn.execute(
            "SELECT 1 FROM faults WHERE fault_type='reset_failed'").fetchone())
        self.assertEqual(svc.conn.execute(
            "SELECT COUNT(*) FROM reset_traces t JOIN reset_tests r ON r.id=t.reset_id"
            " WHERE r.order_id=?", (oid,)).fetchone()[0], 2)  # 双扇两条轨迹
        # 调校/联动/自检三步被打回，未重做前不能再次完工
        undone = {r["step_key"] for r in svc.conn.execute(
            "SELECT step_key FROM repair_steps WHERE order_id=? AND done=0", (oid,))}
        self.assertEqual(undone, {"speed", "linkage", "selfcheck"})
        with self.assertRaisesRegex(ServiceError, "必做步骤未完成"):
            svc.complete_repair(oid, self.u_rep)

    def test_reset_requires_complete_test_items(self) -> None:
        oid = self._ready_order("FM-202")  # 双扇常闭
        with self.assertRaisesRegex(ServiceError, "测试项不完整"):
            self.svc.submit_reset_test(oid, self.u_rep2, {
                "fan_ok": True, "frame_ok": True, "seal_ok": True,
                "close_seconds": 5.0})  # 缺 sequence_ok


class TempMeasureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.svc = make_service(False)
        c = self.svc.conn
        self.u_ins = c.execute("SELECT id FROM users WHERE name='王巡'").fetchone()["id"]
        self.u_rep = c.execute("SELECT id FROM users WHERE name='赵修'").fetchone()["id"]
        self.u_sup = c.execute("SELECT id FROM users WHERE name='孙主管'").fetchone()["id"]
        self.door = c.execute("SELECT id FROM doors WHERE code='FM-103'").fetchone()["id"]

    def test_only_supervisor_approves(self) -> None:
        with self.assertRaisesRegex(ServiceError, "安全主管"):
            self.svc.approve_temp_measure(self.door, self.u_ins, "临时封控", hours=4)
        with self.assertRaisesRegex(ServiceError, "安全主管"):
            self.svc.approve_temp_measure(self.door, self.u_rep, "临时封控", hours=4)
        mid = self.svc.approve_temp_measure(self.door, self.u_sup, "主管批准临时封控", hours=4)
        self.assertEqual(self.svc.conn.execute(
            "SELECT status FROM doors WHERE id=?", (self.door,)).fetchone()["status"],
            "temp_controlled")
        # 生效中不能重复批准
        with self.assertRaisesRegex(ServiceError, "已有生效中的临时措施"):
            self.svc.approve_temp_measure(self.door, self.u_sup, "再来一张", hours=4)
        self.assertGreater(mid, 0)

    def test_measure_expires_and_returns_to_repair(self) -> None:
        svc = self.svc
        # 先开一个活动故障，让到期后状态应为待维修
        svc.generate_route_tasks()
        tid = svc.conn.execute("SELECT id FROM route_tasks ORDER BY id LIMIT 1").fetchone()["id"]
        svc.start_task(tid, self.u_ins)
        svc.submit_door_inspection(tid, self.door, self.u_ins, {
            "fan_ok": True, "frame_ok": True, "close_seconds": 6.0,
            "accessible": True, "wedged": True})
        mid = svc.approve_temp_measure(self.door, self.u_sup, "临时封控", hours=4)
        self.assertEqual(svc.expire_measures(), 0)  # 未到期
        past = svc.iso(svc.now() - timedelta(hours=1))
        svc.conn.execute("UPDATE temp_measures SET expires_at=? WHERE id=?", (past, mid))
        svc.conn.commit()
        self.assertEqual(svc.expire_measures(), 1)
        row = svc.conn.execute(
            "SELECT status FROM temp_measures WHERE id=?", (mid,)).fetchone()
        self.assertEqual(row["status"], "expired")
        # 门体回到待维修（故障仍在），而非正常
        self.assertEqual(svc.conn.execute(
            "SELECT status FROM doors WHERE id=?", (self.door,)).fetchone()["status"],
            "pending_repair")

    def test_release_measure_before_expiry(self) -> None:
        svc = self.svc
        mid = svc.approve_temp_measure(self.door, self.u_sup, "临时封控", hours=4)
        svc.release_temp_measure(mid, self.u_sup)
        self.assertEqual(svc.conn.execute(
            "SELECT status FROM temp_measures WHERE id=?", (mid,)).fetchone()["status"],
            "released")
        self.assertEqual(svc.conn.execute(
            "SELECT status FROM doors WHERE id=?", (self.door,)).fetchone()["status"],
            "normal")


class ZonePermissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.svc = make_service(False)
        c = self.svc.conn
        # 李检仅 FZ-301（2号楼一层），门 FM-301 在其中，FM-103 在 1号楼
        self.u_scoped = c.execute("SELECT id FROM users WHERE name='李检'").fetchone()["id"]
        self.u_sup = c.execute("SELECT id FROM users WHERE name='孙主管'").fetchone()["id"]
        self.allowed = c.execute("SELECT id,zone_id FROM doors WHERE code='FM-301'").fetchone()
        self.denied = c.execute("SELECT id,zone_id FROM doors WHERE code='FM-103'").fetchone()
        svc = self.svc
        svc.generate_route_tasks()

    def test_out_of_zone_denied(self) -> None:
        with self.assertRaisesRegex(ServiceError, "无权操作防火分区"):
            self.svc.require_door_access(self.u_scoped, self.denied["id"])

    def test_in_zone_allowed(self) -> None:
        user = self.svc.require_door_access(self.u_scoped, self.allowed["id"])
        self.assertEqual(user["name"], "李检")

    def test_global_scope_passes(self) -> None:
        for door_id in (self.allowed["id"], self.denied["id"]):
            self.svc.require_door_access(self.u_sup, door_id)

    def test_repair_order_enforces_zone(self) -> None:
        """派单同样受区域权限约束。"""
        svc = self.svc
        # 直接给李检维修角色不可能（角色固定）；构造一个越权主管校验路径：
        # 将孙主管 scope 临时改成仅 FZ-301，再让其在 FM-103 上批临时措施应被拒
        svc.conn.execute("UPDATE users SET zone_scope=? WHERE id=?",
                         (str(self.allowed["zone_id"]), self.u_sup))
        svc.conn.commit()
        with self.assertRaisesRegex(ServiceError, "无权操作防火分区"):
            svc.approve_temp_measure(self.denied["id"], self.u_sup, "越权批准", hours=2)


class TimeoutAndAdapterTests(unittest.TestCase):
    def test_repair_timeout_sweep(self) -> None:
        svc = make_service(False)
        c = svc.conn
        u_ins = c.execute("SELECT id FROM users WHERE name='王巡'").fetchone()["id"]
        u_rep = c.execute("SELECT id FROM users WHERE name='赵修'").fetchone()["id"]
        door = c.execute("SELECT id FROM doors WHERE code='FM-103'").fetchone()["id"]
        svc.generate_route_tasks()
        tid = c.execute("SELECT id FROM route_tasks ORDER BY id LIMIT 1").fetchone()["id"]
        svc.start_task(tid, u_ins)
        svc.submit_door_inspection(tid, door, u_ins, {
            "fan_ok": True, "frame_ok": True, "close_seconds": 1.5,
            "accessible": True})
        fid = c.execute("SELECT id FROM faults WHERE door_id=? AND status='open'",
                        (door,)).fetchone()["id"]
        oid = svc.open_repair_order(fid, u_rep, sla_hours=24)
        past = svc.iso(svc.now() - timedelta(hours=1))
        c.execute("UPDATE repair_orders SET due_at=? WHERE id=?", (past, oid))
        c.commit()
        self.assertEqual(svc.sweep_repair_timeouts(), 1)
        self.assertTrue(c.execute(
            "SELECT 1 FROM faults WHERE fault_type='repair_timeout' AND door_id=?",
            (door,)).fetchone())
        # 幂等：不重复登记
        self.assertEqual(svc.sweep_repair_timeouts(), 0)
        n = c.execute("SELECT COUNT(*) FROM faults WHERE fault_type='repair_timeout' AND door_id=?",
                      (door,)).fetchone()[0]
        self.assertEqual(n, 1)

    def test_adapter_deterministic(self) -> None:
        ok_adapter = ReleaseAdapter()
        self.assertTrue(ok_adapter.release(99)["ok"])
        bad = ReleaseAdapter(fail_doors={7})
        r = bad.release(7)
        self.assertFalse(r["ok"])
        self.assertIsNone(r["response_ms"])
        self.assertIn("NO_FEEDBACK", r["raw"])


if __name__ == "__main__":
    unittest.main()
