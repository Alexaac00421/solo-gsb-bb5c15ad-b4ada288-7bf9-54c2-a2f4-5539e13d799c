'use strict';
// HTTP 服务：赛前配置 / CSV 导入 / 作废 / 实时成绩 / 发布冻结 / 历史榜单
const express = require('express');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);

// db 模块在加载时按 DB_PATH 环境变量（默认 ./data/timing.db）自动打开并初始化
const dbm = require('./src/db');
const { parseCsv } = require('./src/csv');

const app = express();
app.use(express.json({ limit: '10mb' }));
// CSV 以 text/csv（或常见的 text/plain、application/csv）提交时，请求体解析为字符串
app.use(express.text({ type: ['text/csv', 'application/csv', 'text/plain'], limit: '20mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const HEADER_ALIASES = {
  eventId: ['eventid', 'event_id', 'event', 'id', '事件号', '事件id', '事件编号', '记录号'],
  bib:     ['bib', 'runner', 'runnerid', 'runner_id', 'no', 'number', '选手编号', '选手号', '号码', '编号'],
  cpCode:  ['cp', 'cpcode', 'cp_code', 'checkpoint', 'control', 'station', '检查点', '检查点号', '点标', '打卡点'],
  time:    ['time', 'punch', 'punchtime', 'punch_time', 'timestamp', 'datetime', 'date_time', '刷卡时刻', '打卡时刻', '时刻', '时间'],
};

function normalizeHeader(h) {
  return String(h || '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s_\-]/g, '');
}

function mapHeader(headerRow) {
  const norm = headerRow.map(normalizeHeader);
  const map = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasSet = new Set(aliases.map(a => a.toLowerCase().replace(/[\s_\-]/g, '')));
    const idx = norm.findIndex(h => aliasSet.has(h));
    map[key] = idx;
  }
  return map;
}

// 将 CSV 文本解析成待校验行；时刻解析错误挂在 error 上，交给整批校验
function csvToRows(text) {
  const matrix = parseCsv(text);
  // 去掉纯空行
  const lines = matrix
    .map((cells, i) => ({ cells, line: i + 1 }))
    .filter(r => r.cells.some(c => String(c).trim() !== ''));
  if (lines.length === 0) return { error: 'CSV 内容为空' };

  const map = mapHeader(lines[0].cells);
  let cols;
  let firstDataLine;
  if (map.eventId >= 0 && map.bib >= 0 && map.cpCode >= 0 && map.time >= 0) {
    cols = map;
    firstDataLine = lines[1] ? lines[1].line : null; // 表头后无数据行
  } else {
    // 无识别表头：按固定列序 事件号,选手编号,检查点,刷卡时刻
    cols = { eventId: 0, bib: 1, cpCode: 2, time: 3 };
    firstDataLine = lines[0].line;
  }
  if (firstDataLine === null) return { error: 'CSV 只有表头行，缺少数据行' };

  const dataLines = lines.filter(l => l.line >= firstDataLine);
  const rows = [];
  for (const { cells, line } of dataLines) {
    const rawTime = (cells[cols.time] || '').trim();
    const parsed = dbm.parseTimestamp(rawTime);
    rows.push({
      line,
      eventId: (cells[cols.eventId] || '').trim(),
      bib: (cells[cols.bib] || '').trim(),
      cpCode: (cells[cols.cpCode] || '').trim(),
      punchOrig: rawTime,
      parsed: parsed.error ? null : parsed,
      error: parsed.error || null,
    });
  }
  return { rows };
}

// --- API ---
app.get('/api/health', (req, res) => res.json({ ok: true, ...dbm.stats() }));

app.get('/api/setup', (req, res) => res.json(dbm.getSetup()));

app.put('/api/setup', (req, res) => {
  try {
    const setup = dbm.setSetup(req.body || {});
    res.json({ ok: true, setup });
  } catch (e) {
    sendDomainError(res, e);
  }
});

app.get('/api/results/live', (req, res) => {
  const computed = dbm.computeResults();
  res.json({ ok: true, ...(computed || {}), stats: dbm.stats() });
});

app.post('/api/imports', (req, res) => {
  if (!dbm.isConfigured()) return res.status(409).json({ error: { code: 'NOT_CONFIGURED', message: '尚未完成赛前配置' } });
  let text = null;
  if (typeof req.body === 'string') text = req.body;
  else if (req.body && typeof req.body.csv === 'string') text = req.body.csv;
  if (text == null || String(text).trim() === '') {
    return res.status(400).json({ error: { code: 'EMPTY', message: 'CSV 内容为空（请以 text/csv 或 {"csv":"..."} 提交）' } });
  }
  const { rows, error } = csvToRows(text);
  if (error) return res.status(400).json({ error: { code: 'BAD_CSV', message: error } });

  const batchRef = req.body && req.body.batchRef ? String(req.body.batchRef) : `web-${Date.now()}`;
  try {
    const result = dbm.importRows(rows, batchRef);
    res.json({ ok: true, ...result });
  } catch (e) {
    sendDomainError(res, e);
  }
});

app.post('/api/events/:eventId/void', (req, res) => {
  const voided = req.body && typeof req.body.voided === 'boolean' ? req.body.voided : true;
  try {
    res.json({ ok: true, ...dbm.setVoided(req.params.eventId, voided) });
  } catch (e) {
    sendDomainError(res, e);
  }
});

app.post('/api/publications', (req, res) => {
  try {
    const r = dbm.publish(req.body && req.body.note ? String(req.body.note) : '');
    res.json({ ok: true, ...r });
  } catch (e) {
    sendDomainError(res, e);
  }
});

app.get('/api/publications', (req, res) => {
  res.json({ ok: true, publications: dbm.listPublications() });
});

app.get('/api/publications/:id', (req, res) => {
  const p = dbm.getPublication(req.params.id);
  if (!p) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '发布不存在' } });
  res.json({ ok: true, ...p });
});

function sendDomainError(res, e) {
  if (e && e.status) {
    return res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details || null } });
  }
  console.error(e);
  res.status(500).json({ error: { code: 'INTERNAL', message: String(e && e.message || e) } });
}

app.listen(PORT, () => {
  console.log(`[orient-timing] listening on http://0.0.0.0:${PORT}`);
});
