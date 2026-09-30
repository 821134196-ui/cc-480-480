import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  DOOR_STATUS, FAULT_STATUS, REPAIR_STATUS, EVENT_TYPES,
} from './db.js';
import {
  getUser, createInspection, getInspection, startInspection, checkInspectionItem,
  reportFault, createRepairOrder, startRepair, completeRepair, createResetTest,
  approveTempMeasure, revokeTempMeasure, setDecommissioned,
  saveCloseTest, evaluateSequence, applicableResetItems,
  overdueRepairs, overdueInspections,
} from './services.js';
import { httpError, iso, parseJson } from './util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const DATA_DIR = join(__dirname, '..', 'data');
const PHOTO_DIR = join(DATA_DIR, 'photos');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.ico': 'image/x-icon',
};

export function createApp(db, { emAdapter = null } = {}) {
  // ---------- 序列化读取 ----------
  const doorDetail = (id) => {
    const door = db.prepare(`
      SELECT d.*, z.code zone_code, z.name zone_name, z.floor, b.name building_name
      FROM doors d JOIN zones z ON z.id=d.zone_id JOIN buildings b ON b.id=z.building_id
      WHERE d.id=?`).get(id);
    if (!door) throw httpError(404, 'door_not_found', '门体不存在');
    door.components = db.prepare('SELECT * FROM components WHERE door_id=? ORDER BY kind').all(id);
    door.photos = db.prepare('SELECT * FROM photos WHERE door_id=? ORDER BY id DESC').all(id);
    door.faults = db.prepare(`
      SELECT f.*, u.name reporter_name FROM faults f
      LEFT JOIN users u ON u.id=f.reporter_id WHERE f.door_id=? ORDER BY f.id DESC`).all(id);
    door.repair_orders = db.prepare(`
      SELECT ro.*, u.name assignee_name FROM repair_orders ro
      LEFT JOIN users u ON u.id=ro.assignee_id WHERE ro.door_id=? ORDER BY ro.id DESC`).all(id);
    door.reset_tests = db.prepare(`
      SELECT rt.*, u.name tester_name FROM reset_tests rt
      LEFT JOIN users u ON u.id=rt.tester_id WHERE rt.door_id=? ORDER BY rt.id DESC`).all(id);
    door.close_tests = db.prepare('SELECT * FROM close_tests WHERE door_id=? ORDER BY id DESC LIMIT 20').all(id);
    door.active_measure = db.prepare("SELECT * FROM temp_measures WHERE door_id=? AND status='active'").get(id) || null;
    door.events = db.prepare(`
      SELECT e.*, u.name actor_name FROM events e
      LEFT JOIN users u ON u.id=e.actor_id WHERE e.door_id=? ORDER BY e.id DESC LIMIT 30`).all(id);
    return door;
  };

  // ---------- 路由 ----------
  const routes = [];
  const r = (method, pattern, handler) => routes.push({ method, pattern, handler });

  r('GET', /^\/api\/overview$/, () => {
    const one = sql => db.prepare(sql).get().c;
    return {
      doors_total: one('SELECT COUNT(*) c FROM doors'),
      doors_normal: one("SELECT COUNT(*) c FROM doors WHERE status='normal' AND decommissioned=0"),
      doors_fault_open: one("SELECT COUNT(*) c FROM doors WHERE status IN ('pending_repair','repairing','reset_failed')"),
      doors_temp_blocked: one("SELECT COUNT(*) c FROM doors WHERE status='temp_blocked'"),
      doors_decommissioned: one('SELECT COUNT(*) c FROM doors WHERE decommissioned=1'),
      faults_open: one("SELECT COUNT(*) c FROM faults WHERE status!='closed'"),
      repairs_active: one("SELECT COUNT(*) c FROM repair_orders WHERE status IN ('open','in_progress')"),
      repairs_overdue: overdueRepairs(db).length,
      inspections_open: one("SELECT COUNT(*) c FROM inspections WHERE status!='done'"),
      inspections_overdue: overdueInspections(db).length,
      resets_failed: one("SELECT COUNT(*) c FROM reset_tests WHERE result='fail'"),
      measures_active: one("SELECT COUNT(*) c FROM temp_measures WHERE status='active'"),
      zones: one('SELECT COUNT(*) c FROM zones'),
    };
  });

  r('GET', /^\/api\/users$/, () => db.prepare('SELECT id,name,role,zone_ids FROM users WHERE active=1 ORDER BY id').all());
  r('GET', /^\/api\/buildings$/, () => db.prepare('SELECT * FROM buildings ORDER BY id').all());

  r('GET', /^\/api\/zones$/, () => {
    const zones = db.prepare(`
      SELECT z.*, b.name building_name,
        (SELECT COUNT(*) FROM doors d WHERE d.zone_id=z.id) door_count,
        (SELECT COUNT(*) FROM doors d WHERE d.zone_id=z.id AND d.status!='normal' AND d.decommissioned=0) abnormal_count
      FROM zones z JOIN buildings b ON b.id=z.building_id ORDER BY z.id`).all();
    return zones;
  });

  r('GET', /^\/api\/zone-map$/, () => {
    const zones = db.prepare('SELECT * FROM zones ORDER BY id').all();
    const doors = db.prepare(`
      SELECT d.id,d.code,d.name,d.door_type,d.leaf_count,d.status,d.decommissioned,d.seal_status,
             d.gx,d.gy,d.gangle,d.glen,d.zone_id
      FROM doors d ORDER BY d.id`).all();
    const buildings = db.prepare('SELECT * FROM buildings').all();
    return { buildings, zones, doors };
  });

  r('GET', /^\/api\/doors$/, (q, body, actor) => {
    const where = [];
    const args = [];
    if (q.zone_id) { where.push('d.zone_id=?'); args.push(q.zone_id); }
    if (q.status) { where.push('d.status=?'); args.push(q.status); }
    if (actor) {
      const zones = parseJson(actor.zone_ids, []);
      if (zones.length && actor.role === 'inspector') { where.push('d.zone_id IN (' + zones.map(() => '?').join(',') + ')'); args.push(...zones); }
    }
    const sql = `
      SELECT d.*, z.code zone_code, z.name zone_name, z.floor,
        (SELECT COUNT(*) FROM faults f WHERE f.door_id=d.id AND f.status!='closed') open_fault_count,
        (SELECT kind FROM faults f WHERE f.door_id=d.id AND f.status!='closed' ORDER BY f.id LIMIT 1) latest_fault_kind
      FROM doors d JOIN zones z ON z.id=d.zone_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.code`;
    return db.prepare(sql).all(...args);
  });

  r('GET', /^\/api\/doors\/(\d+)$/, (q, body, actor, m) => {
    const d = doorDetail(Number(m[1]));
    d.applicable_reset_items = applicableResetItems(d);
    return d;
  });

  r('POST', /^\/api\/faults$/, (q, body, actor) => {
    const a = actorFor(body, actor);
    return reportFault(db, a, body.doorId, body.kind, { title: body.title, detail: { note: body.note || '' } });
  });

  r('POST', /^\/api\/doors\/(\d+)\/close-tests$/, (q, body, actor, m) => {
    const doorId = Number(m[1]);
    const at = new Date();
    const specs = Array.isArray(body.tests) && body.tests.length ? body.tests : [body];
    const saved = specs.map(s => saveCloseTest(db, doorId, {
      leaf: s.leaf || 'S', openAngle: s.openAngle ?? 90,
      startMoveMs: s.startMoveMs ?? null, latchMs: s.latchMs ?? null, closedMs: s.closedMs ?? null,
      refType: s.refType || 'manual', at,
    }));
    return { tests: saved, sequence: saved.some(t => t.leaf !== 'S')
      ? evaluateSequence(saved) : null };
  });

  r('POST', /^\/api\/doors\/(\d+)\/photos$/, async (q, body, actor, m, req) => {
    const doorId = Number(m[1]);
    if (!db.prepare('SELECT id FROM doors WHERE id=?').get(doorId)) throw httpError(404, 'door_not_found', '门体不存在');
    await mkdir(PHOTO_DIR, { recursive: true });
    const id = db.prepare('SELECT COUNT(*) c FROM photos').get().c + 1;
    const ct = req.headers['content-type'] || '';
    const ext = ct.includes('png') ? 'png' : ct.includes('jpeg') ? 'jpg' : 'svg';
    const buf = await readBodyRaw(req);
    const name = `door${doorId}-${Date.now()}.${ext}`;
    await writeFile(join(PHOTO_DIR, name), buf);
    db.prepare('INSERT INTO photos(door_id,ref_type,path,caption,at) VALUES(?,?,?,?,?)')
      .run(doorId, 'upload', `photos/${name}`, body.caption || '巡检上传照片', iso());
    return { ok: true, path: `photos/${name}` };
  });

  r('POST', /^\/api\/doors\/(\d+)\/decommission$/, (q, body, actor, m) =>
    setDecommissioned(db, actorFor(body, actor), Number(m[1]),
      { active: true, reason: body.reason || '', seal: body.seal || null }));
  r('POST', /^\/api\/doors\/(\d+)\/reactivate$/, (q, body, actor, m) =>
    setDecommissioned(db, actorFor(body, actor), Number(m[1]), { active: false, reason: body.reason || '' }));

  r('GET', /^\/api\/components$/, () => db.prepare(`
    SELECT c.*, d.code door_code FROM components c JOIN doors d ON d.id=c.door_id ORDER BY c.id`).all());

  // 巡检
  r('GET', /^\/api\/inspections$/, () => db.prepare(`
    SELECT i.*, u.name inspector_name,
      (SELECT COUNT(*) FROM inspection_items WHERE inspection_id=i.id AND result!='pending') done_count,
      (SELECT COUNT(*) FROM inspection_items WHERE inspection_id=i.id) total_count,
      CASE WHEN i.status!='done' AND julianday(i.due_at)<julianday('now') THEN 1 ELSE 0 END overdue
    FROM inspections i LEFT JOIN users u ON u.id=i.inspector_id ORDER BY i.id DESC`).all());
  r('GET', /^\/api\/inspections\/(\d+)$/, (q, b, a, m) => getInspection(db, Number(m[1])));
  r('POST', /^\/api\/inspections$/, (q, body, actor) =>
    createInspection(db, actorFor(body, actor), {
      title: body.title, doorIds: body.doorIds || [],
      plannedAt: body.plannedAt ? new Date(body.plannedAt) : new Date(),
      dueHours: body.dueHours ?? 24,
    }));
  r('POST', /^\/api\/inspections\/(\d+)\/start$/, (q, body, actor, m) =>
    startInspection(db, actorFor(body, actor), Number(m[1])));
  r('POST', /^\/api\/inspection-items\/(\d+)\/check$/, (q, body, actor, m) =>
    checkInspectionItem(db, actorFor(body, actor), Number(m[1]), {
      result: body.result, aspects: body.aspects || {}, wedged: !!body.wedged, note: body.note || '',
      emAdapter,
    }));

  // 故障
  r('GET', /^\/api\/faults$/, (q) => {
    const where = [];
    const args = [];
    if (q.status) { where.push('f.status=?'); args.push(q.status); }
    if (q.open === '1') where.push("f.status!='closed'");
    const list = db.prepare(`
      SELECT f.*, d.code door_code, d.name door_name, z.code zone_code,
             u.name reporter_name, ru.name assignee_name,
             (SELECT code FROM repair_orders ro WHERE ro.fault_id=f.id ORDER BY ro.id DESC LIMIT 1) order_code
      FROM faults f
      JOIN doors d ON d.id=f.door_id JOIN zones z ON z.id=d.zone_id
      LEFT JOIN users u ON u.id=f.reporter_id
      LEFT JOIN repair_orders ro2 ON ro2.fault_id=f.id AND ro2.status IN ('open','in_progress')
      LEFT JOIN users ru ON ru.id=ro2.assignee_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY f.id DESC`).all(...args);
    return list;
  });

  // 维修
  r('GET', /^\/api\/repair-orders$/, () => db.prepare(`
    SELECT ro.*, f.kind fault_kind, f.title fault_title, d.code door_code, d.name door_name,
           u.name assignee_name,
           CASE WHEN ro.status IN ('open','in_progress') AND julianday(ro.due_at)<julianday('now') THEN 1 ELSE 0 END overdue
    FROM repair_orders ro
    JOIN faults f ON f.id=ro.fault_id JOIN doors d ON d.id=ro.door_id
    LEFT JOIN users u ON u.id=ro.assignee_id
    ORDER BY ro.id DESC`).all());
  r('POST', /^\/api\/repair-orders$/, (q, body, a) =>
    createRepairOrder(db, actorFor(body, a), body.faultId, { dueHours: body.dueHours ?? 24 }));
  r('POST', /^\/api\/repair-orders\/(\d+)\/start$/, (q, body, a, m) =>
    startRepair(db, actorFor(body, a), Number(m[1])));
  r('POST', /^\/api\/repair-orders\/(\d+)\/complete$/, (q, body, a, m) =>
    completeRepair(db, actorFor(body, a), Number(m[1]), { workNote: body.workNote || '' }));
  r('POST', /^\/api\/repair-orders\/(\d+)\/reset$/, (q, body, a, m) =>
    createResetTest(db, actorFor(body, a), Number(m[1]), {
      items: body.items || {}, note: body.note || '', emAdapter,
    }));

  // 复位测试
  r('GET', /^\/api\/reset-tests$/, () => db.prepare(`
    SELECT rt.*, d.code door_code, u.name tester_name, ro.code order_code
    FROM reset_tests rt JOIN doors d ON d.id=rt.door_id
    JOIN users u ON u.id=rt.tester_id JOIN repair_orders ro ON ro.id=rt.repair_order_id
    ORDER BY rt.id DESC`).all());

  // 临时措施
  r('GET', /^\/api\/temp-measures$/, () => db.prepare(`
    SELECT tm.*, d.code door_code, u.name approver_name FROM temp_measures tm
    JOIN doors d ON d.id=tm.door_id JOIN users u ON u.id=tm.approved_by
    ORDER BY tm.id DESC`).all());
  r('POST', /^\/api\/doors\/(\d+)\/temp-measures$/, (q, body, a, m) =>
    approveTempMeasure(db, actorFor(body, a), Number(m[1]), {
      reason: body.reason || '', expireHours: body.expireHours ?? 24, faultId: body.faultId ?? null,
    }));
  r('POST', /^\/api\/temp-measures\/(\d+)\/revoke$/, (q, body, a, m) =>
    revokeTempMeasure(db, actorFor(body, a), Number(m[1]), { note: body.note || '' }));

  // 逾期统计
  r('GET', /^\/api\/overdue$/, () => ({
    repairs: overdueRepairs(db),
    inspections: overdueInspections(db),
  }));

  // 事件留痕
  r('GET', /^\/api\/events$/, (q) => {
    const where = [];
    const args = [];
    if (q.door_id) { where.push('e.door_id=?'); args.push(q.door_id); }
    if (q.type) { where.push('e.type=?'); args.push(q.type); }
    return db.prepare(`
      SELECT e.*, d.code door_code, u.name actor_name FROM events e
      LEFT JOIN doors d ON d.id=e.door_id LEFT JOIN users u ON u.id=e.actor_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.id DESC LIMIT 200`).all(...args);
  });

  // 提醒
  r('GET', /^\/api\/reminders$/, () => db.prepare(`
    SELECT * FROM reminders ORDER BY fired ASC, at ASC LIMIT 50`).all());

  // 电磁释放适配器（调试/演示）
  r('POST', /^\/api\/em-release\/([\w-]+)\/trigger$/, (q, body, a, m) => {
    if (!emAdapter) throw httpError(503, 'no_adapter', '未配置电磁释放适配器');
    return emAdapter.triggerRelease(decodeURIComponent(m[1]));
  });
  r('POST', /^\/api\/em-release\/([\w-]+)\/configure$/, (q, body, a, m) => {
    if (!emAdapter) throw httpError(503, 'no_adapter', '未配置电磁释放适配器');
    const mode = ['ok', 'no_feedback', 'no_release'].includes(body.mode) ? body.mode : 'no_feedback';
    emAdapter.setScript(decodeURIComponent(m[1]), mode);
    return { doorCode: m[1], mode, message: mode === 'ok' ? '故障脚本已清除，联动恢复正常' : `已注入故障脚本：${mode}` };
  });
  r('POST', /^\/api\/em-release\/([\w-]+)$/, (q, body, a, m) => {
    if (!emAdapter) throw httpError(503, 'no_adapter', '未配置电磁释放适配器');
    return emAdapter.triggerRelease(decodeURIComponent(m[1]));
  });

  function actorFor(body, fallback = null) {
    const id = body.actorId ?? fallback?.id ?? null;
    if (id == null) throw httpError(401, 'actor_required', '请选择当前操作人');
    const u = getUser(db, id);
    if (!u) throw httpError(401, 'actor_required', '操作人不存在或已停用');
    return u;
  }

  // ---------- HTTP 装配 ----------
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;
      const query = Object.fromEntries(url.searchParams);

      if (pathname.startsWith('/api/')) {
        let body = {};
        if (req.method !== 'GET' && req.headers['content-type']?.includes('json')) {
          body = JSON.parse((await readBodyRaw(req)).toString('utf8') || '{}');
        }
        const actorId = req.headers['x-actor-id'] || body.actorId;
        const actor = actorId ? getUser(db, Number(actorId)) : null;
        for (const route of routes) {
          if (route.method !== req.method) continue;
          const m = pathname.match(route.pattern);
          if (!m) continue;
          const data = await route.handler(query, body, actor, m, req);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, data }));
          return;
        }
        throw httpError(404, 'not_found', '接口不存在');
      }

      // 静态：public 与 data/photos
      await serveStatic(res, pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: e.code || 'error', message: e.message } }));
    }
  };
}

async function serveStatic(res, pathname) {
  let file;
  if (pathname.startsWith('/photos/')) {
    file = join(DATA_DIR, normalize(pathname.slice(1)));
    if (!file.startsWith(PHOTO_DIR)) throw httpError(403, 'forbidden', '禁止访问');
  } else {
    const p = pathname === '/' ? '/index.html' : pathname;
    file = join(PUBLIC_DIR, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) throw httpError(403, 'forbidden', '禁止访问');
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    // SPA 回退
    const index = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(index);
  }
}

function readBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function startServer(db, opts = {}) {
  const app = createApp(db, opts);
  const port = opts.port || Number(process.env.PORT) || 3000;
  const server = createServer(app);
  return new Promise(resolve => {
    server.listen(port, () => resolve({ server, port }));
  });
}
