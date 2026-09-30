// 进程内任务：巡检/维修到期提醒、临时措施到期处理、维修超时留痕
import { expireTempMeasure, markRepairOverdue } from './services.js';

export class Scheduler {
  constructor(db, { intervalMs = 30_000, onFire = null } = {}) {
    this.db = db;
    this.intervalMs = intervalMs;
    this.onFire = onFire;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  tick(now = new Date()) {
    const due = this.db.prepare("SELECT * FROM reminders WHERE fired=0 AND at<=? ORDER BY at").all(now.toISOString());
    const fired = [];
    for (const r of due) {
      // 临时措施到期：不仅提醒，还自动失效并回写门体状态
      if (r.type === 'temp_expired' && r.ref_type === 'temp_measure') {
        expireTempMeasure(this.db, r.ref_id);
      }
      if (r.type === 'repair_overdue' && r.ref_type === 'repair_order') {
        markRepairOverdue(this.db, r.ref_id);
      }
      this.db.prepare('UPDATE reminders SET fired=1 WHERE id=?').run(r.id);
      fired.push(r);
      this.onFire?.(r);
    }
    return fired;
  }
}
