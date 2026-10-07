'use strict';

/** 编号排序：数字感知（2 < 10），非数字按字典序。 */
function cmpBib(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * 按当前已提交事件集计算成绩。
 *
 * 规则：
 * - 对每名选手，按检查点顺序依次选取「发枪之后、且在前一已选点之后」的该点最早有效（未作废）记录；
 * - 未被选取的有效记录（重复、乱序、早于发枪等）保留在 extras 中供复核；
 * - 缺任一检查点 → 未完赛（finished=false，missing 列出全部缺点）；
 * - 完赛成绩 = 终点时刻 - 发枪时刻；
 * - 完赛者按 耗时 → 终点时刻 → 选手编号 排序；未完赛者按编号排在完赛者之后。
 */
function computeResults(db) {
  const cfg = db.get('SELECT start_time, start_ms FROM race_config WHERE id = 1');
  const checkpoints = db.all('SELECT seq, code FROM checkpoints ORDER BY seq');
  const runners = db.all('SELECT bib FROM runners').map((r) => r.bib).sort(cmpBib);
  const events = db.all(
    'SELECT id, event_no, bib, checkpoint, punch_raw, punch_ms, voided FROM events ORDER BY punch_ms, id'
  );

  const byBib = new Map();
  for (const e of events) {
    if (!byBib.has(e.bib)) byBib.set(e.bib, []);
    byBib.get(e.bib).push(e);
  }

  const configured = Boolean(cfg) && checkpoints.length > 0;
  const finishers = [];
  const dnfs = [];

  for (const bib of runners) {
    const allOf = byBib.get(bib) || [];
    const valid = allOf.filter((e) => !e.voided);
    const selected = [];
    const missing = [];

    if (configured) {
      let cursor = cfg.start_ms; // 必须严格晚于发枪 / 前一已选点
      for (const cp of checkpoints) {
        const hit = valid.find(
          (e) => e.checkpoint === cp.code && e.punch_ms > cursor && !selected.includes(e)
        );
        if (hit) {
          selected.push(hit);
          cursor = hit.punch_ms;
        } else {
          missing.push(cp.code);
        }
      }
    }

    const selectedIds = new Set(selected.map((e) => e.id));
    const extras = valid.filter((e) => !selectedIds.has(e.id));
    const finished = configured && missing.length === 0;
    const finishMs = finished ? selected[selected.length - 1].punch_ms : null;

    const row = {
      bib,
      finished,
      elapsedMs: finished ? finishMs - cfg.start_ms : null,
      finishMs,
      finishRaw: finished ? selected[selected.length - 1].punch_raw : null,
      splits: selected.map((e, i) => ({
        id: e.id,
        checkpoint: e.checkpoint,
        raw: e.punch_raw,
        ms: e.punch_ms,
        seq: i + 1,
      })),
      missing,
      extras: extras.map((e) => ({ id: e.id, checkpoint: e.checkpoint, raw: e.punch_raw })),
      voidedCount: allOf.length - valid.length,
    };
    (finished ? finishers : dnfs).push(row);
  }

  finishers.sort(
    (a, b) => a.elapsedMs - b.elapsedMs || a.finishMs - b.finishMs || cmpBib(a.bib, b.bib)
  );
  dnfs.sort((a, b) => cmpBib(a.bib, b.bib));

  return {
    configured,
    startTime: cfg ? cfg.start_time : null,
    startMs: cfg ? cfg.start_ms : null,
    checkpoints,
    runnerCount: runners.length,
    finishers,
    dnfs,
    generatedAt: new Date().toISOString(),
  };
}

/** 由成绩结果反推事件采用状态：eventId -> { bib, seq, checkpoint } */
function selectedIndex(results) {
  const idx = new Map();
  for (const row of [...results.finishers, ...results.dnfs]) {
    for (const s of row.splits) idx.set(s.id, { bib: row.bib, seq: s.seq, checkpoint: s.checkpoint });
  }
  return idx;
}

module.exports = { computeResults, selectedIndex, cmpBib };
