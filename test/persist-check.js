'use strict';
// 重启持久化验证：启动→写入→杀进程→重启→数据仍在
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18090;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `persist-${Date.now()}.db`);

function start() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
    stdio: 'ignore',
  });
  return child;
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('not up');
}

async function post(p, body) {
  return fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
}

(async () => {
  let c = start();
  await waitUp();
  await post('/setup', { start_time: '2026-10-07T09:00:00+08:00', checkpoints: 'C1\nFIN', runners: '101' });
  await post('/import', { csv: 'e1,101,C1,2026-10-07T09:10:00+08:00\ne2,101,FIN,2026-10-07T09:40:00+08:00' });
  await post('/publish', {});
  c.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));

  c = start();
  await waitUp();
  const results = await (await fetch(BASE + '/results')).text();
  const pubs = await (await fetch(BASE + '/publications/1')).text();
  const ok = results.includes('0:40:00') && pubs.includes('0:40:00');
  console.log(ok ? '重启持久化 OK（成绩与已发布榜单均在）' : '持久化失败');
  c.kill('SIGKILL');
  for (const f of [DB, DB + '.tmp']) { try { fs.unlinkSync(f); } catch (_) {} }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
