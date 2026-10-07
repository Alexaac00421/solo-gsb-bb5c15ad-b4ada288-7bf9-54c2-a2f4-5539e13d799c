'use strict';

/**
 * 数据层：sql.js（SQLite 的 WASM 构建，纯 JS 无原生编译，产物是标准 SQLite 库文件）。
 *
 * 并发与一致性模型：
 * - Node 单进程内所有请求处理对库的访问都是同步执行的，天然串行，不会交错；
 * - 所有写操作包在 tx() 的 BEGIN IMMEDIATE … COMMIT 中，任一失败整体 ROLLBACK；
 * - 只有 COMMIT 成功后才把库文件落盘（先写临时文件再 rename，原子替换），
 *   因此导入 / 作废 / 发布无论并发如何交错，要么完整生效，要么不留任何部分状态；
 * - 发布在单个事务内完成「读取已提交事件集 → 计算榜单 → 写入快照」，
 *   保证快照与其所据事件集严格对应同一已提交状态。
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'timer.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS race_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  start_time TEXT NOT NULL,          -- 带时区发枪时刻（原始录入串）
  start_ms  INTEGER NOT NULL         -- 换算后的 epoch 毫秒
);

CREATE TABLE IF NOT EXISTS checkpoints (
  seq  INTEGER PRIMARY KEY,          -- 顺序号，从 1 开始；最大 seq 为终点
  code TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS runners (
  bib TEXT PRIMARY KEY               -- 选手编号
);

CREATE TABLE IF NOT EXISTS batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at TEXT NOT NULL,
  source      TEXT,
  total_rows  INTEGER NOT NULL,
  inserted    INTEGER NOT NULL,
  skipped     INTEGER NOT NULL       -- 同内容重传被幂等跳过的行数
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_no   TEXT NOT NULL UNIQUE,   -- 事件号，全局唯一，幂等键
  bib        TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  punch_raw  TEXT NOT NULL,          -- 带时区刷卡时刻（原始串）
  punch_ms   INTEGER NOT NULL,       -- 换算后的 epoch 毫秒
  batch_id   INTEGER NOT NULL REFERENCES batches(id),
  voided     INTEGER NOT NULL DEFAULT 0,
  voided_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_bib ON events(bib, punch_ms);

CREATE TABLE IF NOT EXISTS publications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  published_at  TEXT NOT NULL,
  snapshot_json TEXT NOT NULL        -- 冻结榜单 + 所据事件全集（含作废状态）
);
`;

let db = null;

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function get(sql, params = []) {
  return all(sql, params)[0];
}

function run(sql, params = []) {
  db.run(sql, params);
}

/** 把内存中的库原子写回磁盘（临时文件 + rename）。 */
function persist() {
  const data = db.export();
  const tmp = DB_PATH + '.tmp';
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, DB_PATH);
}

/**
 * 写事务：BEGIN IMMEDIATE → fn() → COMMIT → 落盘。
 * fn 抛错则 ROLLBACK，不落盘，不留部分状态。
 */
function tx(fn) {
  db.run('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.run('COMMIT');
    persist();
    return result;
  } catch (err) {
    try { db.run('ROLLBACK'); } catch (_) { /* 已回滚 */ }
    throw err;
  }
}

async function init() {
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f),
  });
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();
  db.run(SCHEMA); // 幂等建表，即数据库初始化
  persist();
  return { all, get, run, tx, path: DB_PATH };
}

module.exports = { init };
