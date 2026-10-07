'use strict';
// 数据库与领域逻辑层：赛前配置、事件导入、作废、成绩计算、发布冻结
// better-sqlite3 全部为同步调用，事务在单一线程上串行执行，
// 因此"导入/作废/发布并发时对应同一已提交事件集、失败不留部分状态"由
// BEGIN IMMEDIATE 事务直接保证。

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;

const DEFAULT_DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'timing.db');

let db;

function open(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate();
  return db;
}

function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checkpoints (
    seq   INTEGER PRIMARY KEY,   -- 顺序号，从 0 开始；末项为终点
    code  TEXT NOT NULL UNIQUE   -- 检查点编号（去空格后比较）
  );

  CREATE TABLE IF NOT EXISTS runners (
    bib TEXT PRIMARY KEY
  );

  -- 刷卡事件（原始记录，全部保留，含重复/乱序/作废）
  CREATE TABLE IF NOT EXISTS events (
    event_id    TEXT PRIMARY KEY,      -- 事件号，全局唯一（重传幂等键）
    bib         TEXT NOT NULL,
    cp_code     TEXT NOT NULL,
    punch_epoch INTEGER NOT NULL,      -- 刷卡时刻（毫秒，UTC 计算用）
    punch_iso   TEXT NOT NULL,         -- 规范化 UTC 时间
    punch_orig  TEXT NOT NULL,         -- CSV 中原始带时区字符串
    batch_ref   TEXT,                  -- 导入批次标识（时间戳）
    imported_at TEXT NOT NULL,         -- 导入受理时刻
    voided      INTEGER NOT NULL DEFAULT 0,
    voided_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_bib ON events(bib);

  CREATE TABLE IF NOT EXISTS publications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT NOT NULL,
    gun_epoch    INTEGER NOT NULL,
    gun_orig     TEXT NOT NULL,
    num_cps      INTEGER NOT NULL,
    num_events   INTEGER NOT NULL,     -- 冻结时的事件总数（含作废）
    num_voided   INTEGER NOT NULL,
    note         TEXT
  );

  -- 发布时冻结的事件快照（榜单所据事件，随后不可变）
  CREATE TABLE IF NOT EXISTS publication_events (
    pub_id      INTEGER NOT NULL REFERENCES publications(id),
    event_id    TEXT NOT NULL,
    bib         TEXT NOT NULL,
    cp_code     TEXT NOT NULL,
    punch_epoch INTEGER NOT NULL,
    voided      INTEGER NOT NULL,
    selected    INTEGER NOT NULL,      -- 是否被计点算法选中
    status      TEXT NOT NULL,         -- used / duplicate / out_of_order / before_gun
    PRIMARY KEY (pub_id, event_id)
  );

  -- 发布时冻结的选手成绩
  CREATE TABLE IF NOT EXISTS publication_results (
    pub_id          INTEGER NOT NULL REFERENCES publications(id),
    rank            INTEGER,
    bib             TEXT NOT NULL,
    finished        INTEGER NOT NULL,
    elapsed_ms      INTEGER,
    finish_epoch    INTEGER,
    points_count    INTEGER NOT NULL,
    PRIMARY KEY (pub_id, bib)
  );
  `);
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  }
}

// 模块加载即打开/初始化数据库（路径可被 DB_PATH 环境变量覆盖）
open(process.env.DB_PATH || DEFAULT_DB_PATH);

// 写事务统一以 BEGIN IMMEDIATE 开始：立即取得写锁，
// 使"导入/作废/发布"在多进程共享同一库文件时也严格串行化，
// 每个事务读到的都是一个完整已提交的事件集。
const tx = (fn) => db.transaction(fn, { immediate: true });

// ---------------------------------------------------------------------------
// 时间解析：支持带时区偏移 / Z 的 ISO 8601，拒绝不带时区的时刻
// 形如 2026-10-07T10:00:00+08:00 / 2026-10-07 10:00:00Z / 2026-10-07T01:00:00.5Z
// ---------------------------------------------------------------------------
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;

function parseTimestamp(raw) {
  if (raw == null) return { error: '空时刻' };
  const s = String(raw).trim();
  const m = TIME_RE.exec(s);
  if (!m) {
    return { error: `时刻格式无效或缺少时区: "${raw}"` };
  }
  const [, y, mo, d, h, mi, se, frac, zone] = m;
  const year = +y, mon = +mo, day = +d, hour = +h, min = +mi, sec = +se;
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 60) {
    return { error: `时刻取值越界: "${raw}"` };
  }
  // 按年月校验日数（Date.UTC 会把 2 月 31 日静默滚动，需显式拒绝）
  const dim = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28,
               31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mon - 1];
  if (day > dim) return { error: `日期不存在: "${raw}"` };
  let offMin = 0;
  if (zone.toUpperCase() !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const oh = +digits.slice(0, 2);
    const om = digits.length >= 4 ? +digits.slice(2, 4) : 0;
    if (oh > 23 || om > 59) return { error: `时区偏移越界: "${raw}"` };
    offMin = sign * (oh * 60 + om);
  }
  const ms = frac ? +(frac + '00').slice(0, 3) : 0;
  const utcMs = Date.UTC(year, mon - 1, day, hour, min, sec, ms) - offMin * 60000;
  if (isNaN(utcMs)) return { error: `时刻无效: "${raw}"` };
  return { epoch: utcMs, iso: new Date(utcMs).toISOString(), offsetMin: offMin };
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 赛前配置
// ---------------------------------------------------------------------------
function isConfigured() {
  const gun = db.prepare("SELECT value FROM meta WHERE key='gun_epoch'").get();
  const cp = db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get();
  const rn = db.prepare('SELECT COUNT(*) AS n FROM runners').get();
  return Boolean(gun && cp.n > 0 && rn.n > 0);
}

function getSetup() {
  const gunEpoch = meta('gun_epoch');
  const gunOrig = meta('gun_orig') || null;
  const cps = db.prepare('SELECT seq, code FROM checkpoints ORDER BY seq').all();
  const runners = db.prepare('SELECT bib FROM runners ORDER BY bib').all().map(r => r.bib);
  return {
    configured: isConfigured(),
    gunEpoch: gunEpoch == null ? null : +gunEpoch,
    gunOrig,
    checkpoints: cps,
    finishCode: cps.length ? cps[cps.length - 1].code : null,
    runners,
  };
}

function meta(key) {
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return r ? r.value : null;
}

class DomainError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || null;
  }
}

// 整批替换赛前配置；已受理过事件或已有发布后禁止（避免破坏快照一致性）
const setSetup = tx((setup) => {
  const ev = db.prepare('SELECT COUNT(*) AS n FROM events').get();
  const pub = db.prepare('SELECT COUNT(*) AS n FROM publications').get();
  if (ev.n > 0 || pub.n > 0) {
    throw new DomainError(409, 'LOCKED', '已有刷卡记录或已发布，赛前配置已锁定');
  }
  // --- 校验 ---
  const t = setup && setup.gunTime != null ? parseTimestamp(setup.gunTime) : null;
  if (!t || t.error) {
    throw new DomainError(400, 'INVALID_GUN', `发枪时刻无效: ${t ? t.error : '空'}`);
  }
  const rawCps = Array.isArray(setup.checkpoints) ? setup.checkpoints : [];
  const cps = rawCps.map(c => String(c == null ? '' : c).trim()).filter(Boolean);
  if (cps.length < 2) throw new DomainError(400, 'INVALID_CP', '至少需要两个检查点（末项为终点）');
  const seen = new Set();
  for (const c of cps) {
    if (seen.has(c)) throw new DomainError(400, 'INVALID_CP', `检查点重复: ${c}`);
    seen.add(c);
  }
  const rawBibs = Array.isArray(setup.runners) ? setup.runners : [];
  const bibs = rawBibs.map(b => String(b == null ? '' : b).trim()).filter(Boolean);
  if (bibs.length === 0) throw new DomainError(400, 'INVALID_RUNNERS', '至少需要一名选手');
  const seenB = new Set();
  for (const b of bibs) {
    if (seenB.has(b)) throw new DomainError(400, 'INVALID_RUNNERS', `选手编号重复: ${b}`);
    seenB.add(b);
  }

  // --- 全量替换 ---
  db.exec('DELETE FROM checkpoints; DELETE FROM runners;');
  const insMeta = db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  insMeta.run('gun_epoch', String(t.epoch));
  insMeta.run('gun_orig', String(setup.gunTime).trim());
  insMeta.run('gun_offset_min', String(t.offsetMin));
  const insCp = db.prepare('INSERT INTO checkpoints(seq,code) VALUES(?,?)');
  cps.forEach((c, i) => insCp.run(i, c));
  const insRn = db.prepare('INSERT INTO runners(bib) VALUES(?)');
  bibs.forEach(b => insRn.run(b));
  return getSetup();
});

// ---------------------------------------------------------------------------
// CSV 导入：整批校验，任一错误整批回滚；事件号同内容重传幂等跳过
// rows: [{ line, eventId, bib, cpCode, parsed:{epoch,iso}|null, punchOrig, error }]
// ---------------------------------------------------------------------------
const importRows = tx((rows, batchRef) => {
  if (!isConfigured()) throw new DomainError(409, 'NOT_CONFIGURED', '尚未完成赛前配置');

  const cpSet = new Set(db.prepare('SELECT code FROM checkpoints').all().map(r => r.code));
  const bibSet = new Set(db.prepare('SELECT bib FROM runners').all().map(r => r.bib));

  const errors = [];
  const seenInBatch = new Map();   // eventId -> 首见行号
  const valid = [];

  const getExisting = db.prepare('SELECT event_id,bib,cp_code,punch_epoch FROM events WHERE event_id=?');

  for (const r of rows) {
    const eid = (r.eventId || '').trim();
    const bib = (r.bib || '').trim();
    const cp = (r.cpCode || '').trim();

    if (!eid) { errors.push({ line: r.line, message: '事件号为空' }); continue; }
    if (!bib) { errors.push({ line: r.line, message: '选手编号为空' }); continue; }
    if (!cp) { errors.push({ line: r.line, message: '检查点为空' }); continue; }
    if (r.error) { errors.push({ line: r.line, message: r.error }); continue; }

    if (seenInBatch.has(eid)) {
      errors.push({ line: r.line, message: `事件号 ${eid} 在本批中重复（首见第 ${seenInBatch.get(eid)} 行）` });
      continue;
    }
    seenInBatch.set(eid, r.line);

    if (!bibSet.has(bib)) {
      errors.push({ line: r.line, message: `未知选手编号: ${bib}（事件号 ${eid}）` });
      continue;
    }
    if (!cpSet.has(cp)) {
      errors.push({ line: r.line, message: `未知检查点: ${cp}（事件号 ${eid}）` });
      continue;
    }

    // 与已入库事件比较（幂等/冲突）
    const ex = getExisting.get(eid);
    if (ex) {
      if (ex.bib === bib && ex.cp_code === cp && ex.punch_epoch === r.parsed.epoch) {
        continue; // 同内容重传：幂等跳过，不计错误、不重复写入
      }
      errors.push({
        line: r.line,
        message: `事件号 ${eid} 已存在但内容不同（已存: 选手=${ex.bib}, 检查点=${ex.cp_code}, 时刻=${ex.punch_epoch}）`,
      });
      continue;
    }

    // 同内容不同事件号：允许（同一刷卡由不同设备重复上报，原始记录保留；
    // 计点时只取最早一条，其余在明细中标注为 duplicate）
    valid.push({
      eventId: eid, bib, cpCode: cp,
      epoch: r.parsed.epoch, iso: r.parsed.iso, orig: r.punchOrig,
    });
  }

  if (errors.length) {
    const err = new Error('导入校验失败，整批拒绝');
    err.domain = true;
    err.status = 400;
    err.code = 'BATCH_REJECTED';
    err.details = errors;
    throw err; // 抛出即回滚整个事务
  }

  const ins = db.prepare(`INSERT INTO events
    (event_id,bib,cp_code,punch_epoch,punch_iso,punch_orig,batch_ref,imported_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const stamp = nowIso();
  for (const v of valid) {
    ins.run(v.eventId, v.bib, v.cpCode, v.epoch, v.iso, v.orig, batchRef || null, stamp);
  }
  return { imported: valid.length, skipped: seenInBatch.size - valid.length, at: stamp };
});

// ---------------------------------------------------------------------------
// 作废 / 取消作废（事务，即时重算由读接口完成）
// ---------------------------------------------------------------------------
const setVoided = tx((eventId, voided) => {
  if (!isConfigured()) throw new DomainError(409, 'NOT_CONFIGURED', '尚未完成赛前配置');
  const ev = db.prepare('SELECT * FROM events WHERE event_id=?').get(eventId);
  if (!ev) throw new DomainError(404, 'NOT_FOUND', `事件号不存在: ${eventId}`);
  if (voided) {
    db.prepare('UPDATE events SET voided=1, voided_at=? WHERE event_id=?').run(nowIso(), eventId);
  } else {
    db.prepare('UPDATE events SET voided=0, voided_at=NULL WHERE event_id=?').run(eventId);
  }
  return { eventId, voided: voided ? 1 : 0 };
});

// ---------------------------------------------------------------------------
// 核心计点算法：按刷卡时刻，为每人依次选取
//   发枪后、前一点之后 各检查点的最早有效记录
// 未选中记录保留并标注 duplicate / out_of_order / before_gun 供复核
// ---------------------------------------------------------------------------
function computeResults(rowsOverride) {
  const setup = getSetup();
  if (!setup.configured) return null;

  const cps = setup.checkpoints;          // [{seq,code}]，末项终点
  const cpByCode = new Map(cps.map(c => [c.code, c.seq]));
  const gunEpoch = setup.gunEpoch;

  const loadRows = () => db.prepare(
    'SELECT event_id,bib,cp_code,punch_epoch,punch_orig,voided FROM events ORDER BY punch_epoch,event_id'
  ).all();
  const rows = rowsOverride || loadRows();

  // 以全部注册选手初始化：零刷卡者同样出榜并标记未完赛
  const byRunner = new Map(setup.runners.map(bib => [bib, []]));
  for (const e of rows) {
    if (!byRunner.has(e.bib)) byRunner.set(e.bib, []); // 防御：理论上导入已拦截未知选手
    byRunner.get(e.bib).push(e);
  }
  for (const list of byRunner.values()) {
    list.sort((a, b) => a.punch_epoch - b.punch_epoch || a.event_id.localeCompare(b.event_id));
  }

  const results = [];
  const annotated = []; // {event, status, selected}

  for (const [bib, list] of byRunner) {
    let prev = gunEpoch;
    let points = 0;
    let finishEpoch = null;
    const selectedIds = new Set();
    const selectedEpochBySeq = new Array(cps.length).fill(null);
    const annot = new Map();

    for (let seq = 0; seq < cps.length; seq++) {
      const code = cps[seq].code;
      let pick = null;
      for (const e of list) {
        if (e.voided) continue;
        if (e.cp_code !== code) continue;
        if (annot.get(e.event_id)) continue; // 已被更早的点选中（同号检查点不重复）
        if (e.punch_epoch >= prev) { pick = e; break; } // 最早一条满足约束
      }
      if (pick) {
        selectedIds.add(pick.event_id);
        annot.set(pick.event_id, 'used');
        selectedEpochBySeq[seq] = pick.punch_epoch;
        prev = pick.punch_epoch + 1; // 后一点必须严格晚于本点
        points++;
        if (seq === cps.length - 1) finishEpoch = pick.punch_epoch;
      } else {
        break; // 缺本点：后续点不再可计，未完赛
      }
    }

    // 标注所有未选中的有效记录
    for (const e of list) {
      if (e.voided) continue;
      if (annot.has(e.event_id)) continue;
      let status;
      if (e.punch_epoch < gunEpoch) {
        status = 'before_gun';
      } else {
        const seq = cpByCode.get(e.cp_code);
        const selectedAt = seq == null ? null : selectedEpochBySeq[seq];
        if (selectedAt != null && e.punch_epoch >= selectedAt) {
          // 该点已有计点记录，这是其后的再次刷卡 -> 重复
          status = 'duplicate';
        } else {
          // 早于该点计点时刻（提前刷错/顺序颠倒），或该点未被计到 -> 乱序
          status = 'out_of_order';
        }
      }
      annot.set(e.event_id, status);
    }

    const finished = points === cps.length;
    results.push({
      bib,
      finished: finished ? 1 : 0,
      pointsCount: points,
      elapsedMs: finished ? finishEpoch - gunEpoch : null,
      finishEpoch: finished ? finishEpoch : null,
      selectedIds,
    });

    for (const e of list) {
      annotated.push({
        eventId: e.event_id, bib: e.bib, cpCode: e.cp_code,
        punchEpoch: e.punch_epoch, punchOrig: e.punch_orig,
        voided: e.voided ? 1 : 0,
        selected: selectedIds.has(e.event_id) ? 1 : 0,
        status: e.voided ? 'voided' : (annot.get(e.event_id) || 'out_of_order'),
      });
    }
  }

  // 排序：完赛者按 耗时↑、终点时刻↑、选手编号（自然序）；未完赛列后
  results.sort((a, b) => {
    if (a.finished !== b.finished) return b.finished - a.finished;
    if (a.finished) {
      if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
      if (a.finishEpoch !== b.finishEpoch) return a.finishEpoch - b.finishEpoch;
    } else {
      if (a.pointsCount !== b.pointsCount) return b.pointsCount - a.pointsCount;
    }
    return bibCompare(a.bib, b.bib);
  });
  results.forEach((r, i) => { r.rank = r.finished ? i + 1 : null; });

  return {
    gunEpoch,
    gunOrig: setup.gunOrig,
    checkpoints: cps,
    finishCode: setup.finishCode,
    results,
    events: annotated,
  };
}

// 选手编号排序：数值段按数值比较，其余按字符串（如 2 < 10 < 10a）
function bibCompare(a, b) {
  const na = String(a), nb = String(b);
  if (/^\d+$/.test(na) && /^\d+$/.test(nb)) return Number(na) - Number(nb);
  return na.localeCompare(nb, 'zh-Hans-CN', { numeric: true });
}

// ---------------------------------------------------------------------------
// 发布：冻结榜单与所据事件（单一事务，读算写原子完成）
// ---------------------------------------------------------------------------
const publish = tx((note) => {
  if (!isConfigured()) throw new DomainError(409, 'NOT_CONFIGURED', '尚未完成赛前配置');
  const computed = computeResults();
  const allEvents = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  const voidedN = db.prepare('SELECT COUNT(*) AS n FROM events WHERE voided=1').get().n;
  const setup = getSetup();

  const info = db.prepare(`INSERT INTO publications
    (created_at,gun_epoch,gun_orig,num_cps,num_events,num_voided,note)
    VALUES (?,?,?,?,?,?,?)`)
    .run(nowIso(), setup.gunEpoch, setup.gunOrig, setup.checkpoints.length, allEvents, voidedN, note || null);
  const pubId = info.lastInsertRowid;

  const insEv = db.prepare(`INSERT INTO publication_events
    (pub_id,event_id,bib,cp_code,punch_epoch,voided,selected,status) VALUES (?,?,?,?,?,?,?,?)`);
  const statusOf = new Map(computed.events.map(e => [e.eventId, e]));
  for (const e of db.prepare('SELECT event_id,bib,cp_code,punch_epoch,voided FROM events').all()) {
    const a = statusOf.get(e.event_id);
    insEv.run(pubId, e.event_id, e.bib, e.cp_code, e.punch_epoch, e.voided,
      a ? a.selected : 0, a ? a.status : 'out_of_order');
  }

  const insRes = db.prepare(`INSERT INTO publication_results
    (pub_id,rank,bib,finished,elapsed_ms,finish_epoch,points_count) VALUES (?,?,?,?,?,?,?)`);
  for (const r of computed.results) {
    insRes.run(pubId, r.rank, r.bib, r.finished, r.elapsedMs, r.finishEpoch, r.pointsCount);
  }
  return { publicationId: pubId };
});

function listPublications() {
  return db.prepare(`SELECT id,created_at,gun_epoch,gun_orig,num_cps,num_events,num_voided,note
                     FROM publications ORDER BY id DESC`).all();
}

function getPublication(id) {
  const pub = db.prepare('SELECT * FROM publications WHERE id=?').get(id);
  if (!pub) return null;
  const results = db.prepare(
    'SELECT rank,bib,finished,elapsed_ms AS elapsedMs,finish_epoch AS finishEpoch,points_count AS pointsCount FROM publication_results WHERE pub_id=? ORDER BY finished DESC, points_count DESC, COALESCE(rank,999999), bib'
  ).all(id);
  const events = db.prepare(
    'SELECT event_id AS eventId,bib,cp_code AS cpCode,punch_epoch AS punchEpoch,voided,selected,status FROM publication_events WHERE pub_id=? ORDER BY bib,punch_epoch,event_id'
  ).all(id);
  return { pub, results, events };
}

function stats() {
  return {
    configured: isConfigured(),
    events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
    voided: db.prepare('SELECT COUNT(*) AS n FROM events WHERE voided=1').get().n,
    publications: db.prepare('SELECT COUNT(*) AS n FROM publications').get().n,
  };
}

module.exports = {
  open, parseTimestamp, DomainError,
  getSetup, setSetup, isConfigured,
  importRows, setVoided,
  computeResults, publish, listPublications, getPublication, stats,
};
