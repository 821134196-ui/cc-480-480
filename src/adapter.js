// 电磁释放模拟适配器：返回模拟的释放联动信号
// 真实部署时替换为消防联动主机驱动；此处依据门体编号的故障脚本产生确定性结果。
// 故障脚本优先取进程内 Map，其次查 SQLite（release_scripts），保证重启后演示仍一致。
import { iso } from './util.js';

// 进程内脚本（单元测试使用，不落库）
const SCRIPT = new Map();

export function configureRelease(doorCode, mode) {
  // mode: 'ok' 正常回传 | 'no_feedback' 信号无回传 | 'no_release' 不释放
  SCRIPT.set(doorCode, mode);
}

export function resetReleaseScripts() {
  SCRIPT.clear();
}

export class EMReleaseAdapter {
  constructor({ latencyMs = 120, db = null } = {}) {
    this.latencyMs = latencyMs;
    this.db = db;
  }

  resolveMode(doorCode) {
    if (SCRIPT.has(doorCode)) return SCRIPT.get(doorCode);
    if (this.db) {
      const row = this.db.prepare('SELECT mode FROM release_scripts WHERE door_code=?').get(doorCode);
      if (row) return row.mode;
    }
    return 'ok';
  }

  // 持久化故障脚本（演示/运维接口）
  setScript(doorCode, mode) {
    if (!this.db) { configureRelease(doorCode, mode); return; }
    this.db.prepare(`
      INSERT INTO release_scripts(door_code,mode,updated_at) VALUES(?,?,?)
      ON CONFLICT(door_code) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at`
    ).run(doorCode, mode, iso());
  }

  clearScript(doorCode) {
    SCRIPT.delete(doorCode);
    if (this.db) this.db.prepare('DELETE FROM release_scripts WHERE door_code=?').run(doorCode);
  }

  // 模拟消防联动触发：常开防火门应断电释放并关门
  triggerRelease(doorCode) {
    const mode = this.resolveMode(doorCode);
    const at = iso();
    if (mode === 'no_feedback') {
      return { doorCode, at, command: 'release', ok: false, code: 'no_feedback',
        released: null, closed: null, latencyMs: null,
        message: '指令已下发，门体无信号回传' };
    }
    if (mode === 'no_release') {
      return { doorCode, at, command: 'release', ok: false, code: 'no_release',
        released: false, closed: false, latencyMs: this.latencyMs,
        message: '电磁释放器未动作，门体保持吸合' };
    }
    return { doorCode, at, command: 'release', ok: true, code: 'ok',
      released: true, closed: true, latencyMs: this.latencyMs,
      message: '已断电释放，门扇关闭，信号回传正常' };
  }

  // 模拟复位（重新上电吸合）
  rearm(doorCode) {
    return { doorCode, at: iso(), command: 'rearm', ok: this.resolveMode(doorCode) === 'ok',
      latencyMs: this.latencyMs, message: '电磁释放器重试吸合' };
  }
}
