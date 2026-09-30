"""进程内调度：定时生成巡检任务、扫描维修超时与临时措施到期、触发提醒。

使用 threading 守护线程，不依赖外部任务队列。每个 tick：
  1. 生成当日巡检任务；
  2. 扫描维修 SLA 超时；
  3. 扫描临时措施到期；
  4. 到期且未通知的提醒置 fired 并进入内存通知列表（演示用）。
"""
from __future__ import annotations

import threading
import time
from datetime import datetime

from .service import FireDoorService


class ReminderScheduler:
    def __init__(self, svc: FireDoorService, interval_seconds: float = 30.0) -> None:
        self.svc = svc
        self.interval = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.notifications: list[dict] = []
        self._lock = threading.Lock()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="reminder-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def tick(self) -> dict:
        created_tasks = self.svc.generate_route_tasks()
        timeouts = self.svc.sweep_repair_timeouts()
        expired = self.svc.expire_measures()
        fired = self._fire_due_reminders()
        return {"new_tasks": created_tasks, "repair_timeouts": timeouts,
                "measures_expired": expired, "reminders_fired": fired}

    def _fire_due_reminders(self) -> int:
        n = 0
        rows = self.svc.conn.execute(
            "SELECT * FROM reminders WHERE fired=0 AND due_at<=?",
            (self.svc.iso(),)).fetchall()
        for r in rows:
            self.svc.conn.execute("UPDATE reminders SET fired=1 WHERE id=?", (r["id"],))
            with self._lock:
                self.notifications.append({
                    "id": r["id"], "kind": r["kind"], "message": r["message"],
                    "due_at": r["due_at"], "fired_at": self.svc.iso()})
            n += 1
        self.svc.conn.commit()
        return n

    def drain_notifications(self) -> list[dict]:
        with self._lock:
            out, self.notifications = self.notifications, []
            return out

    def _run(self) -> None:
        # 启动即跑一次
        self.tick()
        while not self._stop.wait(self.interval):
            try:
                self.tick()
            except Exception as exc:  # 调度线程不能因单次异常退出
                with self._lock:
                    self.notifications.append({"kind": "scheduler_error",
                                               "message": f"调度异常：{exc}",
                                               "fired_at": datetime.now().isoformat(timespec="seconds")})
