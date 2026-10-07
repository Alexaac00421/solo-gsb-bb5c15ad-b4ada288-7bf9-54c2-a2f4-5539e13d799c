'use strict';

const express = require('express');
const dbmod = require('./db');
const { parseTimestamp } = require('./csv');
const { importCsv } = require('./importer');
const { computeResults, selectedIndex } = require('./results');
const views = require('./views');

const PORT = Number(process.env.PORT || 8080);

function parseLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function validateSetup(body) {
  const errors = [];
  const startMs = parseTimestamp(body.start_time);
  if (startMs === null) errors.push('发枪时刻无效或缺少时区（示例：2026-10-07T09:00:00+08:00）');

  const checkpoints = parseLines(body.checkpoints);
  if (checkpoints.length === 0) errors.push('至少需要 1 个检查点（末项为终点）');
  if (new Set(checkpoints).size !== checkpoints.length) errors.push('检查点存在重复');

  const runners = parseLines(body.runners);
  if (runners.length === 0) errors.push('至少需要 1 名选手');
  if (new Set(runners).size !== runners.length) errors.push('选手编号存在重复');

  return { errors, startMs, checkpoints, runners, startTime: String(body.start_time || '').trim() };
}

async function main() {
  const db = await dbmod.init();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '10mb' }));

  const render = (res, title, body, msg) => res.send(views.layout(title, body, msg));

  // 首页
  app.get('/', (req, res) => {
    const cfg = db.get('SELECT start_time FROM race_config WHERE id = 1');
    const checkpoints = db.all('SELECT code FROM checkpoints ORDER BY seq');
    render(res, '首页', views.homePage({
      cfg,
      checkpoints,
      runnerCount: db.get('SELECT COUNT(*) AS n FROM runners').n,
      eventCount: db.get('SELECT COUNT(*) AS n FROM events').n,
      voidedCount: db.get('SELECT COUNT(*) AS n FROM events WHERE voided = 1').n,
      batchCount: db.get('SELECT COUNT(*) AS n FROM batches').n,
      latestPub: db.get('SELECT id, published_at FROM publications ORDER BY id DESC LIMIT 1'),
    }), req.query.msg);
  });

  // 赛前录入
  app.get('/setup', (req, res) => {
    const cfg = db.get('SELECT start_time FROM race_config WHERE id = 1');
    render(res, '赛前录入', views.setupPage({
      cfg,
      checkpoints: db.all('SELECT code FROM checkpoints ORDER BY seq').map((r) => r.code),
      runners: db.all('SELECT bib FROM runners').map((r) => r.bib),
      errors: null,
      eventCount: db.get('SELECT COUNT(*) AS n FROM events').n,
    }), req.query.msg);
  });

  app.post('/setup', (req, res) => {
    const v = validateSetup(req.body);
    if (v.errors.length > 0) {
      res.status(422);
      return render(res, '赛前录入', views.setupPage({
        cfg: { start_time: v.startTime },
        checkpoints: parseLines(req.body.checkpoints),
        runners: parseLines(req.body.runners),
        errors: v.errors,
        eventCount: db.get('SELECT COUNT(*) AS n FROM events').n,
      }));
    }
    db.tx(() => {
      db.run('INSERT OR REPLACE INTO race_config (id, start_time, start_ms) VALUES (1, ?, ?)',
        [v.startTime, v.startMs]);
      db.run('DELETE FROM checkpoints');
      v.checkpoints.forEach((code, i) => {
        db.run('INSERT INTO checkpoints (seq, code) VALUES (?, ?)', [i + 1, code]);
      });
      db.run('DELETE FROM runners');
      for (const bib of v.runners) db.run('INSERT INTO runners (bib) VALUES (?)', [bib]);
    });
    res.redirect('/setup?msg=' + encodeURIComponent('赛前信息已保存'));
  });

  // 导入
  app.get('/import', (req, res) => {
    render(res, '导入', views.importPage(null), req.query.msg);
  });

  app.post('/import', (req, res) => {
    const result = importCsv(db, req.body.csv || '', (req.body.source || '').trim());
    if (!result.ok) res.status(422);
    render(res, '导入结果', views.importPage(result));
  });

  // 刷卡记录与作废 / 恢复
  app.get('/events', (req, res) => {
    const results = computeResults(db);
    render(res, '刷卡记录', views.eventsPage({
      events: db.all('SELECT * FROM events ORDER BY id'),
      selIdx: selectedIndex(results),
    }), req.query.msg);
  });

  app.post('/events/:id/void', (req, res) => {
    db.tx(() => {
      db.run('UPDATE events SET voided = 1, voided_at = ? WHERE id = ?',
        [new Date().toISOString(), Number(req.params.id)]);
    });
    res.redirect('/events?msg=' + encodeURIComponent(`记录 #${req.params.id} 已作废，成绩已即时重算`));
  });

  app.post('/events/:id/unvoid', (req, res) => {
    db.tx(() => {
      db.run('UPDATE events SET voided = 0, voided_at = NULL WHERE id = ?', [Number(req.params.id)]);
    });
    res.redirect('/events?msg=' + encodeURIComponent(`记录 #${req.params.id} 已恢复，成绩已即时重算`));
  });

  // 实时成绩
  app.get('/results', (req, res) => {
    render(res, '实时成绩', views.resultsPage(computeResults(db)), req.query.msg);
  });

  // 发布：单事务内计算快照并写入，保证榜单与所据事件集对应同一已提交状态
  app.post('/publish', (req, res) => {
    const id = db.tx(() => {
      const snapshot = {
        version: 1,
        results: computeResults(db),
        events: db.all('SELECT id, event_no, bib, checkpoint, punch_raw, punch_ms, voided, batch_id FROM events ORDER BY id'),
      };
      db.run('INSERT INTO publications (published_at, snapshot_json) VALUES (?, ?)',
        [new Date().toISOString(), JSON.stringify(snapshot)]);
      return db.get('SELECT last_insert_rowid() AS id').id;
    });
    res.redirect(`/publications/${id}`);
  });

  // 发布历史与回看
  app.get('/publications', (req, res) => {
    const pubs = db.all('SELECT id, published_at, snapshot_json FROM publications ORDER BY id DESC')
      .map((p) => {
        const snap = JSON.parse(p.snapshot_json);
        return {
          id: p.id,
          published_at: p.published_at,
          finishedCount: snap.results.finishers.length,
          dnfCount: snap.results.dnfs.length,
          eventCount: snap.events.length,
          voidedCount: snap.events.filter((e) => e.voided).length,
        };
      });
    render(res, '发布历史', views.publicationsPage(pubs), req.query.msg);
  });

  app.get('/publications/:id', (req, res) => {
    const pub = db.get('SELECT id, published_at, snapshot_json FROM publications WHERE id = ?',
      [Number(req.params.id)]);
    if (!pub) {
      res.status(404);
      return render(res, '未找到', '<h1>404</h1><div class="err">发布记录不存在。</div>');
    }
    render(res, `发布 #${pub.id}`, views.publicationPage(pub, JSON.parse(pub.snapshot_json)));
  });

  app.use((req, res) => {
    res.status(404);
    render(res, '未找到', '<h1>404</h1><div class="err">页面不存在。</div>');
  });

  // 统一错误处理：事务已回滚，不留部分状态
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500);
    render(res, '错误', `<h1>500</h1><div class="err">操作失败，已回滚，未写入部分数据。${views.esc(err.message)}</div>`);
  });

  app.listen(PORT, () => {
    console.log(`定向赛计时裁决台已启动: http://localhost:${PORT}`);
    console.log(`数据库文件: ${db.path}`);
  });
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
