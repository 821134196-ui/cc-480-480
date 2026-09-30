"""重建演示数据库：一条命令生成楔门、联动失败、复位退回等样例。"""
from __future__ import annotations

import sys
from pathlib import Path

from .app import create_app

DB = "data/firedoor.db"
PHOTOS = "data/photos"


def main() -> int:
    for suffix in ("", "-wal", "-shm"):
        p = Path(DB + suffix)
        if p.exists():
            p.unlink()
    # 清掉演示照片（保留 .gitkeep）
    pdir = Path(PHOTOS)
    if pdir.exists():
        for f in pdir.iterdir():
            if f.is_file() and f.name != ".gitkeep":
                f.unlink()
    svc, _ = create_app(db_path=DB, photo_dir=PHOTOS, start_scheduler=False)
    c = svc.conn
    print("演示数据已生成：")
    print(f"  楼栋 {c.execute('SELECT COUNT(*) FROM buildings').fetchone()[0]} 个，"
          f"防火分区 {c.execute('SELECT COUNT(*) FROM fire_zones').fetchone()[0]} 个，"
          f"门体 {c.execute('SELECT COUNT(*) FROM doors').fetchone()[0]} 扇")
    print(f"  用户 {c.execute('SELECT COUNT(*) FROM users').fetchone()[0]} 名，"
          f"巡检路线 {c.execute('SELECT COUNT(*) FROM inspection_routes').fetchone()[0]} 条，"
          f"巡检任务 {c.execute('SELECT COUNT(*) FROM route_tasks').fetchone()[0]} 单")
    print("  样例事件：")
    for code, label in (("wedged", "门体被楔开（FM-101 / FM-102）"),
                        ("no_signal", "电磁释放联动失败、信号无回传（FM-203）"),
                        ("reset_failed", "复位测试不合格退回（FM-102）"),
                        ("closing_too_fast", "闭门过快（FM-105 维修超时素材）"),
                        ("seal_deficient", "封堵缺陷 + 到期临时措施（FM-106）")):
        n = c.execute("SELECT COUNT(*) FROM faults WHERE fault_type=?", (code,)).fetchone()[0]
        print(f"    - {label}：{n} 单")
    print(f"  事件留痕 {c.execute('SELECT COUNT(*) FROM events').fetchone()[0]} 条，"
          f"信号日志 {c.execute('SELECT COUNT(*) FROM release_signals').fetchone()[0]} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
