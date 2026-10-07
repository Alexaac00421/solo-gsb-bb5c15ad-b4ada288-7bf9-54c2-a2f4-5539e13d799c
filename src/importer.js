'use strict';

const { parseCsv, parseTimestamp } = require('./csv');

/**
 * 整批导入 CSV。
 *
 * 校验规则（任一失败则整批拒绝，并给出全部出错行号）：
 * - 每行 4 列：事件号,选手编号,检查点,带时区刷卡时刻；
 * - 刷卡时刻必须带时区且可解析；
 * - 选手编号、检查点必须已在赛前录入；
 * - 事件号全局唯一：同内容重传幂等跳过；内容不一致（含文件内自相矛盾）报错并指出行号。
 *
 * 全部通过后在单个事务内写入批次与事件，失败不留部分状态。
 */
function importCsv(db, text, source) {
  const rows = parseCsv(text).filter((r) => r.fields.some((f) => f.trim() !== ''));
  if (rows.length === 0) {
    return { ok: false, errors: [{ lineNo: 0, msg: 'CSV 内容为空' }] };
  }

  // 可选表头：首行首列为 event_no / 事件号 时跳过
  let dataRows = rows;
  const head0 = rows[0].fields[0] ? rows[0].fields[0].trim().toLowerCase() : '';
  if (head0 === 'event_no' || head0 === 'eventno' || head0 === '事件号') {
    dataRows = rows.slice(1);
  }
  if (dataRows.length === 0) {
    return { ok: false, errors: [{ lineNo: 1, msg: '除表头外没有数据行' }] };
  }

  const knownBibs = new Set(db.all('SELECT bib FROM runners').map((r) => r.bib));
  const knownCps = new Set(db.all('SELECT code FROM checkpoints').map((r) => r.code));
  const existing = new Map(
    db.all('SELECT event_no, bib, checkpoint, punch_ms FROM events').map((r) => [r.event_no, r])
  );

  const errors = [];
  const seen = new Map(); // 本文件内首次出现的事件号
  const toInsert = [];
  let skipped = 0;

  for (const { lineNo, fields } of dataRows) {
    if (fields.length !== 4) {
      errors.push({ lineNo, msg: `列数应为 4（事件号,选手编号,检查点,刷卡时刻），实际 ${fields.length} 列` });
      continue;
    }
    const [eventNo, bib, cp, raw] = fields.map((f) => f.trim());
    const ms = parseTimestamp(raw);
    let bad = false;
    if (!eventNo) { errors.push({ lineNo, msg: '事件号为空' }); bad = true; }
    if (ms === null) { errors.push({ lineNo, msg: `刷卡时刻无效或缺少时区：「${raw}」` }); bad = true; }
    if (!knownBibs.has(bib)) { errors.push({ lineNo, msg: `未知选手编号「${bib}」` }); bad = true; }
    if (!knownCps.has(cp)) { errors.push({ lineNo, msg: `未知检查点「${cp}」` }); bad = true; }
    if (bad) continue;

    const prev = seen.get(eventNo);
    if (prev) {
      if (prev.bib === bib && prev.checkpoint === cp && prev.punch_ms === ms) {
        skipped++; // 文件内同内容重复
        continue;
      }
      errors.push({ lineNo, msg: `事件号「${eventNo}」与第 ${prev.lineNo} 行内容不一致` });
      continue;
    }
    seen.set(eventNo, { lineNo, bib, checkpoint: cp, punch_ms: ms });

    const ex = existing.get(eventNo);
    if (ex) {
      if (ex.bib === bib && ex.checkpoint === cp && ex.punch_ms === ms) {
        skipped++; // 同内容重传，幂等跳过
        continue;
      }
      errors.push({
        lineNo,
        msg: `事件号「${eventNo}」已存在且内容不一致（库中：${ex.bib} / ${ex.checkpoint}）`,
      });
      continue;
    }
    toInsert.push({ event_no: eventNo, bib, checkpoint: cp, punch_raw: raw, punch_ms: ms });
  }

  if (errors.length > 0) {
    return { ok: false, errors, totalRows: dataRows.length };
  }

  const batchId = db.tx(() => {
    db.run(
      'INSERT INTO batches (imported_at, source, total_rows, inserted, skipped) VALUES (?,?,?,?,?)',
      [new Date().toISOString(), source || null, dataRows.length, toInsert.length, skipped]
    );
    const id = db.get('SELECT last_insert_rowid() AS id').id;
    for (const r of toInsert) {
      db.run(
        'INSERT INTO events (event_no, bib, checkpoint, punch_raw, punch_ms, batch_id) VALUES (?,?,?,?,?,?)',
        [r.event_no, r.bib, r.checkpoint, r.punch_raw, r.punch_ms, id]
      );
    }
    return id;
  });

  return { ok: true, batchId, inserted: toInsert.length, skipped, totalRows: dataRows.length };
}

module.exports = { importCsv };
