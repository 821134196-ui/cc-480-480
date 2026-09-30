"""应用引导：创建服务、装载演示数据、配置模拟适配器与调度器。"""
from __future__ import annotations

from pathlib import Path

from .demo import FAIL_RELEASE_DOOR_CODES, build_demo
from .scheduler import ReminderScheduler
from .service import FireDoorService, ReleaseAdapter


def create_app(db_path: str | Path = "data/firedoor.db",
               photo_dir: str | Path = "data/photos",
               with_samples: bool = True,
               start_scheduler: bool = True) -> tuple[FireDoorService, ReminderScheduler | None]:
    svc = FireDoorService(db_path=db_path, photo_dir=photo_dir)
    # 无论库是否新建，模拟适配器都要按门编号配置联动失败门
    code_to_id = {r["code"]: r["id"] for r in svc.conn.execute("SELECT id,code FROM doors")}
    svc.adapter = ReleaseAdapter(
        fail_doors=[code_to_id[c] for c in FAIL_RELEASE_DOOR_CODES if c in code_to_id])
    fresh = svc.conn.execute("SELECT COUNT(*) c FROM buildings").fetchone()["c"] == 0
    if fresh:
        if with_samples:
            build_demo(svc, with_samples=False)
            # 台账建好后适配器门 id 才可用，重新绑定一次
            rows = svc.conn.execute(
                f"SELECT id FROM doors WHERE code IN ({','.join('?' * len(FAIL_RELEASE_DOOR_CODES))})",
                FAIL_RELEASE_DOOR_CODES).fetchall()
            svc.adapter = ReleaseAdapter(fail_doors=[r["id"] for r in rows])
            from .demo import _build_samples  # 样例事件
            doors = {r["code"]: r["id"] for r in svc.conn.execute("SELECT id,code FROM doors")}
            users = [r["id"] for r in svc.conn.execute("SELECT id FROM users ORDER BY id")]
            routes = [r["id"] for r in svc.conn.execute("SELECT id FROM inspection_routes ORDER BY id")]
            _build_samples(svc, doors, users, routes)
        else:
            build_demo(svc, with_samples=False)

    sched = None
    if start_scheduler:
        sched = ReminderScheduler(svc)
        sched.start()
    return svc, sched
