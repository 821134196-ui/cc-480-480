// 一条本地启动命令：node src/start.js（或 npm start）
// 自动初始化 SQLite 演示数据、启动进程内提醒调度与电磁释放模拟适配器。
import { initDbFile, DB_PATH } from './seed.js';
import { startServer } from './server.js';
import { Scheduler } from './scheduler.js';
import { EMReleaseAdapter } from './adapter.js';

const RESET = process.argv.includes('--reset');
if (RESET) {
  const { rmSync } = await import('node:fs');
  for (const ext of ['', '-wal', '-shm']) rmSync(DB_PATH + ext, { force: true });
}

const { db, seeded } = initDbFile();
const emAdapter = new EMReleaseAdapter({ db });
const scheduler = new Scheduler(db, {
  intervalMs: 15_000,
  onFire: (r) => console.log(`[提醒 ${new Date(r.at).toLocaleString('zh-CN')}] ${r.message}`),
});
// 启动即补跑一次到期任务（如演示中的临时措施、维修超时）
const firedNow = scheduler.tick(new Date(Date.now() + 0));
for (const r of firedNow) console.log(`[到期] ${r.message}`);
scheduler.start();

const port = Number(process.env.PORT) || 3000;
await startServer(db, { port, emAdapter });
console.log(`防火门巡检系统已启动：http://localhost:${port}`);
console.log(seeded ? '已生成演示数据（楔门 / 联动失败 / 复位退回 / 临时封控 / 逾期）' : '载入已有数据库');
console.log('操作人：王安全(安全主管) / 赵巡检(巡检员) / 周大锤(维修工)；孙小巡、吴地下用于区域权限演示');
