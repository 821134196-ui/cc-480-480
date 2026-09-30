"""基于标准库的 HTTP 服务：REST API + 静态前端。"""
from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .app import create_app
from .service import (CLOSE_SECONDS_MAX, CLOSE_SECONDS_MIN, FAULT_LABELS,
                      REPAIR_STEP_TEMPLATES, ServiceError)

ROOT = Path(__file__).parent
STATIC = ROOT / "static"


def rowdict(row) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    if "polygon" in d and isinstance(d["polygon"], str):
        d["polygon"] = json.loads(d["polygon"])
    if "door_order" in d and isinstance(d["door_order"], str):
        d["door_order"] = json.loads(d["door_order"])
    if "fail_reasons" in d and isinstance(d["fail_reasons"], str):
        d["fail_reasons"] = json.loads(d["fail_reasons"])
    if "samples" in d and isinstance(d["samples"], str):
        d["samples"] = json.loads(d["samples"])
    if "data" in d and isinstance(d["data"], str):
        try:
            d["data"] = json.loads(d["data"])
        except ValueError:
            pass
    return d


def rows(list_rows) -> list[dict]:
    return [rowdict(r) for r in list_rows]


class Handler(BaseHTTPRequestHandler):
    svc = None
    sched = None

    # ---- 基础响应 ----
    def _send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json({"error": message}, status)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise ServiceError("请求体不是合法 JSON")

    def log_message(self, fmt, *args):  # 静默默认访问日志
        pass

    # ---- 路由 ----
    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        path, qs = url.path, parse_qs(url.query)
        try:
            if path == "/":
                self._serve_file("index.html", "text/html; charset=utf-8")
            elif path.startswith("/static/"):
                self._serve_static(path[len("/static/"):])
            elif path == "/photos/":
                self._serve_photo(qs.get("p", [""])[0])
            elif path == "/api/meta":
                self._meta()
            elif path == "/api/map":
                self._send_json(rowdict(self.svc.zone_map(int(qs["zone_id"][0]))))
            elif path == "/api/door":
                self._send_json({k: (rows(v) if isinstance(v, list) else rowdict(v))
                                 for k, v in self.svc.door_detail(int(qs["id"][0])).items()})
            elif path == "/api/faults":
                self._send_json(rows(self.svc.list_faults(qs.get("status", [None])[0])))
            elif path == "/api/tasks":
                self._tasks()
            elif path == "/api/orders":
                self._orders()
            elif path == "/api/resets":
                self._resets(qs)
            elif path == "/api/overdue":
                stats = self.svc.overdue_stats()
                self._send_json({**stats,
                                 "inspection_overdue": rows(stats["inspection_overdue"]),
                                 "repair_overdue": rows(stats["repair_overdue"]),
                                 "measures_expired": rows(stats["measures_expired"])})
            elif path == "/api/events":
                door_id = qs.get("door_id", [None])[0]
                args = (" WHERE door_id=? ORDER BY ts DESC LIMIT 80", (int(door_id),)) if door_id \
                    else (" ORDER BY ts DESC LIMIT 80", ())
                self._send_json(rows(self.svc.conn.execute(
                    "SELECT e.*, u.name actor_name FROM events e LEFT JOIN users u ON u.id=e.actor_id"
                    + args[0], args[1]).fetchall()))
            elif path == "/api/notifications":
                self._send_json({"notifications": list(self.sched.notifications)})
            elif path == "/api/release-log":
                door_id = qs.get("door_id", [None])[0]
                sql = ("SELECT s.*, d.code door_code FROM release_signals s JOIN doors d ON d.id=s.door_id")
                args: tuple = ()
                if door_id:
                    sql += " WHERE door_id=?"
                    args = (int(door_id),)
                sql += " ORDER BY s.created_at DESC LIMIT 30"
                self._send_json(rows(self.svc.conn.execute(sql, args).fetchall()))
            else:
                self._error(404, "未找到")
        except ServiceError as exc:
            self._error(400, str(exc))
        except FileNotFoundError as exc:
            self._error(404, str(exc))
        except Exception as exc:  # noqa: BLE001
            self._error(500, f"服务器错误：{exc}")

    def do_POST(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        path, body = url.path, self._body()
        try:
            # 系统动作（调度）无需操作人
            if path == "/api/scheduler/tick":
                self._send_json(self.sched.tick())
                return
            uid = int(body.pop("user_id"))

            if path == "/api/tasks/start":
                self.svc.start_task(int(body["task_id"]), uid)
            elif path == "/api/tasks/finish":
                self.svc.finish_task(int(body["task_id"]), uid)
            elif path == "/api/inspections":
                res = self.svc.submit_door_inspection(
                    int(body["task_id"]), int(body["door_id"]), uid, body)
                self._send_json(res, 201)
                return
            elif path == "/api/orders":
                oid = self.svc.open_repair_order(int(body["fault_id"]), uid,
                                                 sla_hours=int(body.get("sla_hours", 24)),
                                                 force=bool(body.get("force")))
                self._send_json({"order_id": oid}, 201)
                return
            elif m := re.fullmatch(r"/api/orders/(\d+)/step", path):
                self.svc.complete_step(int(m.group(1)), body["step_key"], uid,
                                       body.get("note", ""))
            elif m := re.fullmatch(r"/api/orders/(\d+)/complete", path):
                self.svc.complete_repair(int(m.group(1)), uid, body.get("note", ""))
            elif m := re.fullmatch(r"/api/doors/(\d+)/release", path):
                self._send_json(self.svc.trigger_release(int(m.group(1)), uid))
                return
            elif path == "/api/resets":
                res = self.svc.submit_reset_test(int(body["order_id"]), uid, body)
                self._send_json(res, 201)
                return
            elif path == "/api/measures":
                mid = self.svc.approve_temp_measure(
                    int(body["door_id"]), uid, body["reason"],
                    hours=int(body.get("hours", 24)),
                    fault_id=body.get("fault_id"))
                self._send_json({"measure_id": mid}, 201)
                return
            elif m := re.fullmatch(r"/api/measures/(\d+)/release", path):
                self.svc.release_temp_measure(int(m.group(1)), uid)
            elif m := re.fullmatch(r"/api/doors/(\d+)/decommission", path):
                self.svc.set_decommission(int(m.group(1)), uid,
                                          body.get("reason", ""), bool(body.get("active", True)))
            else:
                self._error(404, "未找到")
                return
            self._send_json({"ok": True})
        except ServiceError as exc:
            self._error(400, str(exc))
        except (KeyError, ValueError) as exc:
            self._error(400, f"参数错误：{exc}")
        except Exception as exc:  # noqa: BLE001
            self._error(500, f"服务器错误：{exc}")

    # ---- 视图数据 ----
    def _meta(self) -> None:
        conn = self.svc.conn
        self._send_json({
            "users": rows(conn.execute("SELECT * FROM users WHERE active=1 ORDER BY role,id")),
            "buildings": rows(conn.execute("SELECT * FROM buildings ORDER BY id")),
            "zones": rows(conn.execute(
                "SELECT z.*, b.name building_name FROM fire_zones z JOIN buildings b ON b.id=z.building_id"
                " ORDER BY b.id,z.id")),
            "doors": rows(conn.execute(
                "SELECT d.id,d.code,d.zone_id,d.location,d.door_type,d.leaf_count,d.status,"
                " d.map_x,d.map_y,d.map_angle FROM doors d ORDER BY d.code")),
            "routes": rows(conn.execute("SELECT * FROM inspection_routes ORDER BY id")),
            "constants": {
                "fault_labels": FAULT_LABELS,
                "repair_steps": [{"key": k, "label": l} for k, l in REPAIR_STEP_TEMPLATES],
                "close_window": [CLOSE_SECONDS_MIN, CLOSE_SECONDS_MAX],
            },
        })

    def _tasks(self) -> None:
        conn = self.svc.conn
        tasks = rows(conn.execute(
            "SELECT t.*, r.name route_name, u.name assignee_name FROM route_tasks t"
            " JOIN inspection_routes r ON r.id=t.route_id"
            " LEFT JOIN users u ON u.id=t.assigned_to ORDER BY t.due_at"))
        for t in tasks:
            route = conn.execute("SELECT door_order FROM inspection_routes WHERE id=?",
                                 (t["route_id"],)).fetchone()
            order = json.loads(route["door_order"])
            done = {r["door_id"] for r in conn.execute(
                "SELECT DISTINCT door_id FROM door_inspections WHERE task_id=?", (t["id"],))}
            t["door_total"] = len(order)
            t["door_done"] = len(done)
            t["next_door_id"] = next((d for d in order if d not in done), None)
        self._send_json(tasks)

    def _orders(self) -> None:
        conn = self.svc.conn
        out = []
        for o in rows(conn.execute(
                "SELECT o.*, d.code door_code, u.name repairer_name, f.code fault_code,"
                " f.fault_type FROM repair_orders o JOIN doors d ON d.id=o.door_id"
                " LEFT JOIN users u ON u.id=o.repairer_id JOIN faults f ON f.id=o.fault_id"
                " ORDER BY o.created_at DESC")):
            o["steps"] = rows(conn.execute(
                "SELECT s.*, u.name done_by_name FROM repair_steps s"
                " LEFT JOIN users u ON u.id=s.done_by WHERE order_id=? ORDER BY s.id", (o["id"],)))
            out.append(o)
        self._send_json(out)

    def _resets(self, qs) -> None:
        door_id = qs.get("door_id", [None])[0]
        resets = rows(self.svc.list_reset_tests(int(door_id) if door_id else None))
        if "id" in qs:
            detail = self.svc.reset_detail(int(qs["id"][0]))
            self._send_json({"reset": rowdict(detail["reset"]),
                             "traces": rows(detail["traces"])})
            return
        self._send_json(resets)

    # ---- 静态文件 ----
    def _serve_file(self, name: str, ctype: str) -> None:
        p = STATIC / name
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_static(self, rel: str) -> None:
        p = (STATIC / rel).resolve()
        if not str(p).startswith(str(STATIC.resolve())) or not p.is_file():
            self._error(404, "未找到")
            return
        ctype = {".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                 ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg"}.get(
                     p.suffix, "application/octet-stream")
        self._serve_file(str(p.relative_to(STATIC)), ctype)

    def _serve_photo(self, rel: str) -> None:
        # 仅允许 data/photos 下的文件
        base = (self.svc.photo_dir).resolve()
        p = (Path.cwd() / rel).resolve() if rel else base
        if not str(p).startswith(str(base)) or not p.is_file():
            self._error(404, "照片不存在")
            return
        ctype = {".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
                 ".jpeg": "image/jpeg"}.get(p.suffix, "application/octet-stream")
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def run(host: str = "127.0.0.1", port: int = 8066,
        db_path: str = "data/firedoor.db", reset: bool = False) -> None:
    if reset:
        for suffix in ("", "-wal", "-shm"):
            p = Path(db_path + suffix)
            if p.exists():
                p.unlink()
    svc, sched = create_app(db_path=db_path)
    Handler.svc = svc
    Handler.sched = sched
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"防火门巡检与复位系统已启动: http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if sched:
            sched.stop()
        httpd.server_close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="防火门闭门器巡检与复位系统")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8066)
    parser.add_argument("--reset", action="store_true", help="删除旧库并重新生成演示数据")
    args = parser.parse_args()
    run(args.host, args.port, reset=args.reset)
