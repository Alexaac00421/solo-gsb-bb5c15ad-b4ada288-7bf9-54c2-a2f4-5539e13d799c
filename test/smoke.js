'use strict';

/**
 * 端到端冒烟测试：启动真实服务器，走通
 * 赛前录入 → 导入 → 幂等重传 → 冲突拒批 → 作废/恢复 → 发布冻结 → 补传只影响下次发布。
 * 运行：npm run smoke
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18080;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `smoke-${Date.now()}.db`);

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

async function get(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const CSV1 = `event_no,bib,checkpoint,punch_time
e1,101,C1,2026-10-07T09:10:00+08:00
e2,101,C2,2026-10-07T09:20:00+08:00
e3,101,C3,2026-10-07T09:30:00+08:00
e4,101,FIN,2026-10-07T09:40:00+08:00
e5,102,C1,2026-10-07T09:12:00+08:00
e6,102,C3,2026-10-07T09:31:00+08:00
e7,103,C1,2026-10-07T09:11:00+08:00
e8,103,C2,2026-10-07T09:19:00+08:00
e9,103,C3,2026-10-07T09:29:00+08:00
e10,103,FIN,2026-10-07T09:39:00+08:00
e11,101,C2,2026-10-07T09:05:00+08:00
e12,101,C1,2026-10-07T09:10:30+08:00
`;

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  // 等待就绪
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/'); if (r.ok) { up = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) { console.error('服务器未就绪'); child.kill(); process.exit(1); }

  try {
    console.log('== 1. 赛前录入 ==');
    let r = await post('/setup', {
      start_time: '2026-10-07T09:00:00+08:00',
      checkpoints: 'C1\nC2\nC3\nFIN',
      runners: '101\n102\n103',
    });
    check('录入保存成功(302)', r.status === 302, `got ${r.status}`);

    r = await post('/setup', { start_time: '2026-10-07 09:00', checkpoints: 'C1\nC1', runners: '' });
    check('录入校验：无时区/重复点/空选手被拒绝(422)', r.status === 422 && r.text.includes('时区') && r.text.includes('重复'));

    console.log('== 2. 导入与整批校验 ==');
    r = await post('/import', { csv: CSV1, source: 'smoke' });
    check('首批导入成功', r.status === 200 && r.text.includes('新入库 12 条'), `status=${r.status}`);

    r = await post('/import', { csv: CSV1 });
    check('同内容重传幂等（0 新增 12 跳过）', r.status === 200 && r.text.includes('新入库 0 条') && r.text.includes('跳过 12 条'));

    r = await post('/import', { csv: 'e1,101,C1,2026-10-07T09:15:00+08:00\ne99,101,C1,2026-10-07T09:16:00+08:00' });
    check('同号异内容拒批并指行号', r.status === 422 && r.text.includes('第 1 行') && r.text.includes('e1'));
    let ev = await get('/events');
    check('拒批后未写入 e99', !ev.text.includes('e99'));

    r = await post('/import', { csv: 'x1,999,C1,2026-10-07T09:00:01+08:00\nx2,101,NOPE,2026-10-07T09:00:02+08:00\nx3,101,C1,2026-10-07T09:00:03' });
    check('未知选手/检查点/缺时区均指行号拒批',
      r.status === 422 && r.text.includes('第 1 行') && r.text.includes('999')
        && r.text.includes('第 2 行') && r.text.includes('NOPE')
        && r.text.includes('第 3 行') && r.text.includes('时区'));

    console.log('== 3. 成绩计算 ==');
    let res = await get('/results');
    const i103 = res.text.indexOf('>103<');
    const i101 = res.text.indexOf('>101<');
    check('103 第一(0:39:00) 101 第二(0:40:00)', i103 > -1 && i101 > -1 && i103 < i101
      && res.text.includes('0:39:00') && res.text.includes('0:40:00'));
    check('102 未完赛并标出缺点', res.text.includes('未完赛') && res.text.includes('C2'));

    ev = await get('/events');
    check('乱序/重复记录保留复核(e11,e12 未采用)', (ev.text.match(/未采用/g) || []).length >= 2);

    console.log('== 4. 作废与即时重算 ==');
    r = await post('/events/9/void', {}); // e9: 103 的 C3
    check('作废返回重定向', r.status === 302);
    res = await get('/results');
    check('作废后 103 变未完赛', res.text.indexOf('未完赛') > -1 && /103[\s\S]*?未完赛|未完赛[\s\S]*?103/.test(res.text));
    r = await post('/events/9/unvoid', {});
    res = await get('/results');
    check('恢复后 103 回到完赛榜第一', res.text.indexOf('>103<') > -1 && res.text.indexOf('>103<') < res.text.indexOf('>101<'));

    console.log('== 5. 发布冻结与回看 ==');
    r = await post('/publish', {});
    check('发布重定向到 /publications/1', r.status === 302 && r.headers.get('location') === '/publications/1');
    let pub1 = await get('/publications/1');
    check('发布1含 103 与 0:39:00', pub1.text.includes('>103<') && pub1.text.includes('0:39:00'));

    await post('/events/4/void', {}); // 作废 101 终点
    res = await get('/results');
    check('作废后实时榜 101 未完赛', /101[\s\S]*?未完赛|未完赛[\s\S]*?101/.test(res.text));
    pub1 = await get('/publications/1');
    check('旧发布不受作废影响（仍含 101 完赛 0:40:00）', pub1.text.includes('>101<') && pub1.text.includes('0:40:00'));

    r = await post('/import', { csv: 'e13,102,C2,2026-10-07T09:25:00+08:00\ne14,102,FIN,2026-10-07T09:45:00+08:00' });
    check('补传导入成功', r.status === 200 && r.text.includes('新入库 2 条'));
    res = await get('/results');
    check('补传后实时榜 102 完赛(0:45:00)', res.text.includes('0:45:00'));
    pub1 = await get('/publications/1');
    check('旧发布不受补传影响（无 0:45:00）', !pub1.text.includes('0:45:00'));

    r = await post('/publish', {});
    check('第二次发布为 #2', r.status === 302 && r.headers.get('location') === '/publications/2');
    const pub2 = await get('/publications/2');
    check('发布2含 102 完赛(0:45:00)', pub2.text.includes('0:45:00'));
    pub1 = await get('/publications/1');
    check('发布1仍可回看且未变', pub1.status === 200 && pub1.text.includes('0:40:00') && !pub1.text.includes('0:45:00'));

    const pubs = await get('/publications');
    check('发布历史列出两期', pubs.text.includes('/publications/1') && pubs.text.includes('/publications/2'));
  } finally {
    child.kill();
    for (const f of [DB_PATH, DB_PATH + '.tmp']) { try { fs.unlinkSync(f); } catch (_) {} }
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
