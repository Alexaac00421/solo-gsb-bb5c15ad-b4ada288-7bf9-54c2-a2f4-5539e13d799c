'use strict';

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

/** 耗时格式化：H:MM:SS（有毫秒时追加 .mmm） */
function fmtDuration(ms) {
  if (ms == null) return '-';
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const mmm = abs % 1000;
  const p2 = (n) => String(n).padStart(2, '0');
  let out = `${sign}${h}:${p2(m)}:${p2(s)}`;
  if (mmm) out += `.${String(mmm).padStart(3, '0')}`;
  return out;
}

const NAV = [
  ['/', '首页'],
  ['/setup', '赛前录入'],
  ['/import', '导入'],
  ['/events', '刷卡记录'],
  ['/results', '实时成绩'],
  ['/publications', '发布历史'],
];

function layout(title, body, msg) {
  const nav = NAV.map(([href, label]) => `<a href="${href}">${label}</a>`).join('');
  const banner = msg ? `<div class="msg">${esc(msg)}</div>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 定向赛计时裁决台</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
         margin: 0; background: #f4f6f8; color: #1c2530; }
  header { background: #14532d; color: #fff; padding: 10px 20px; display: flex;
           align-items: baseline; gap: 18px; flex-wrap: wrap; }
  header .brand { font-weight: 700; font-size: 17px; }
  header nav a { color: #d9e8dd; text-decoration: none; margin-right: 14px; font-size: 14px; }
  header nav a:hover { color: #fff; text-decoration: underline; }
  main { max-width: 1080px; margin: 20px auto; padding: 0 16px 48px; }
  h1 { font-size: 20px; margin: 8px 0 14px; }
  h2 { font-size: 16px; margin: 22px 0 8px; }
  .card { background: #fff; border: 1px solid #dde3e8; border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border: 1px solid #dde3e8; padding: 6px 10px; font-size: 14px; text-align: left; }
  th { background: #eef2f5; }
  tr.voided td { color: #9aa4ad; text-decoration: line-through; }
  .msg { background: #e7f6ec; border: 1px solid #9ed8b2; color: #14532d; border-radius: 6px;
         padding: 8px 12px; margin-bottom: 12px; }
  .err { background: #fdecea; border: 1px solid #f2b8b0; color: #8c1d12; border-radius: 6px;
         padding: 8px 12px; margin-bottom: 12px; }
  .muted { color: #66727d; font-size: 13px; }
  .tag { display: inline-block; border-radius: 4px; padding: 1px 7px; font-size: 12px; }
  .tag.ok { background: #e7f6ec; color: #14532d; }
  .tag.warn { background: #fff4e0; color: #8a5a00; }
  .tag.bad { background: #fdecea; color: #8c1d12; }
  button, .btn { background: #14532d; color: #fff; border: 0; border-radius: 6px;
                 padding: 7px 16px; font-size: 14px; cursor: pointer; text-decoration: none; }
  button.small { padding: 2px 10px; font-size: 12px; }
  button.gray { background: #6b7680; }
  textarea { width: 100%; font-family: ui-monospace, Consolas, monospace; font-size: 13px;
             border: 1px solid #c9d2d9; border-radius: 6px; padding: 8px; }
  input[type=text] { border: 1px solid #c9d2d9; border-radius: 6px; padding: 6px 8px; font-size: 14px; }
  label { font-size: 14px; font-weight: 600; display: block; margin: 10px 0 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .stat { font-size: 24px; font-weight: 700; }
  form.inline { display: inline; }
</style>
</head>
<body>
<header><span class="brand">定向赛计时裁决台</span><nav>${nav}</nav></header>
<main>${banner}${body}</main>
</body>
</html>`;
}

function homePage({ cfg, checkpoints, runnerCount, eventCount, voidedCount, batchCount, latestPub }) {
  const cpList = checkpoints.length
    ? checkpoints.map((c) => esc(c.code)).join(' → ') + '（末点为终点）'
    : '<span class="muted">尚未录入</span>';
  const pub = latestPub
    ? `<a href="/publications/${latestPub.id}">第 ${latestPub.id} 期（${esc(latestPub.published_at)}）</a>`
    : '<span class="muted">尚未发布</span>';
  return `
<h1>赛事总览</h1>
<div class="grid">
  <div class="card"><div class="muted">发枪时刻（带时区）</div><div class="stat" style="font-size:16px">${esc(cfg ? cfg.start_time : '未设置')}</div></div>
  <div class="card"><div class="muted">选手数</div><div class="stat">${runnerCount}</div></div>
  <div class="card"><div class="muted">刷卡事件（作废）</div><div class="stat">${eventCount} <span class="muted" style="font-size:14px">(${voidedCount})</span></div></div>
  <div class="card"><div class="muted">导入批次</div><div class="stat">${batchCount}</div></div>
</div>
<div class="card"><b>检查点顺序：</b>${cpList}</div>
<div class="card"><b>最近发布：</b>${pub}</div>
<div class="card">
  <a class="btn" href="/setup">赛前录入</a>
  <a class="btn" href="/import">导入 CSV</a>
  <a class="btn" href="/results">实时成绩</a>
</div>`;
}

function setupPage({ cfg, checkpoints, runners, errors, eventCount }) {
  const errBlock = errors && errors.length
    ? `<div class="err"><b>保存失败：</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  const warn = eventCount > 0
    ? `<div class="err">注意：库中已有 ${eventCount} 条刷卡事件，修改检查点 / 选手会影响成绩计算与后续导入校验。</div>`
    : '';
  return `
<h1>赛前录入</h1>
${errBlock}${warn}
<form method="post" action="/setup" class="card">
  <label for="start_time">发枪时刻（必须带时区，如 2026-10-07T09:00:00+08:00）</label>
  <input type="text" id="start_time" name="start_time" size="36" value="${esc(cfg ? cfg.start_time : '')}">
  <label for="checkpoints">检查点（每行一个，按顺序；最后一行为终点，不可重复）</label>
  <textarea id="checkpoints" name="checkpoints" rows="6">${esc(checkpoints.join('\n'))}</textarea>
  <label for="runners">选手编号（每行一个，不可重复）</label>
  <textarea id="runners" name="runners" rows="8">${esc(runners.join('\n'))}</textarea>
  <p><button type="submit">保存</button></p>
</form>`;
}

function importPage(result) {
  let block = '';
  if (result) {
    block = result.ok
      ? `<div class="msg">导入成功：共 ${result.totalRows} 行，新入库 ${result.inserted} 条，同内容重传跳过 ${result.skipped} 条（批次 #${result.batchId}）。</div>`
      : `<div class="err"><b>整批拒绝（未写入任何数据），共 ${result.errors.length} 处错误：</b>
         <ul>${result.errors.map((e) => `<li>第 ${e.lineNo} 行：${esc(e.msg)}</li>`).join('')}</ul></div>`;
  }
  return `
<h1>导入刷卡 CSV</h1>
${block}
<div class="card">
  <p class="muted">CSV 每行 4 列：<code>事件号,选手编号,检查点,刷卡时刻</code>；首行可作为表头。
  刷卡时刻必须带时区（如 <code>2026-10-07T09:30:00+08:00</code>）。
  整批校验：事件号同内容重传自动跳过；内容冲突、未知选手 / 检查点将指出行号并拒绝整批。</p>
  <form method="post" action="/import">
    <label for="source">来源说明（可选）</label>
    <input type="text" id="source" name="source" size="36" placeholder="如：主站打卡器 A">
    <label for="csv">CSV 内容</label>
    <textarea id="csv" name="csv" rows="12" placeholder="event_no,bib,checkpoint,punch_time"></textarea>
    <p><input type="file" id="file" accept=".csv,text/csv,text/plain"></p>
    <p><button type="submit">校验并导入</button></p>
  </form>
</div>
<script>
document.getElementById('file').addEventListener('change', function () {
  const f = this.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => { document.getElementById('csv').value = r.result; };
  r.readAsText(f);
});
</script>`;
}

function eventsPage({ events, selIdx }) {
  const rows = events.map((e) => {
    const sel = selIdx.get(e.id);
    let status, cls = '';
    if (e.voided) { status = '<span class="tag bad">已作废</span>'; cls = ' class="voided"'; }
    else if (sel) { status = `<span class="tag ok">采用 · ${esc(sel.bib)} 第${sel.seq}点</span>`; }
    else { status = '<span class="tag warn">未采用（重复/乱序，保留复核）</span>'; }
    const action = e.voided
      ? `<form class="inline" method="post" action="/events/${e.id}/unvoid"><button class="small gray" type="submit">恢复</button></form>`
      : `<form class="inline" method="post" action="/events/${e.id}/void" onsubmit="return confirm('确认作废该条记录？成绩将即时重算。')"><button class="small" type="submit">作废</button></form>`;
    return `<tr${cls}><td>${e.id}</td><td>${esc(e.event_no)}</td><td>${esc(e.bib)}</td>
      <td>${esc(e.checkpoint)}</td><td>${esc(e.punch_raw)}</td><td>#${e.batch_id}</td>
      <td>${status}</td><td>${action}</td></tr>`;
  }).join('');
  return `
<h1>刷卡记录（共 ${events.length} 条）</h1>
<div class="card">
<table>
<thead><tr><th>ID</th><th>事件号</th><th>选手</th><th>检查点</th><th>刷卡时刻</th><th>批次</th><th>状态</th><th>操作</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8" class="muted">暂无记录</td></tr>'}</tbody>
</table>
</div>`;
}

/** 成绩表渲染（实时与发布快照共用） */
function resultsTables(r) {
  const finRows = r.finishers.map((row, i) => `
    <tr><td>${i + 1}</td><td>${esc(row.bib)}</td><td><b>${fmtDuration(row.elapsedMs)}</b></td>
    <td>${esc(row.finishRaw)}</td>
    <td>${row.splits.map((s) => `${esc(s.checkpoint)} ${esc(s.raw)}`).join('<br>')}</td>
    <td>${row.extras.length ? `<span class="tag warn">${row.extras.length} 条未采用</span>` : '-'}
        ${row.voidedCount ? `<span class="tag bad">${row.voidedCount} 条作废</span>` : ''}</td></tr>`
  ).join('');

  const dnfRows = r.dnfs.map((row) => `
    <tr><td>${esc(row.bib)}</td><td><span class="tag bad">未完赛</span></td>
    <td>${row.missing.length ? esc(row.missing.join('、')) : '-'}</td>
    <td>${row.splits.map((s) => `${esc(s.checkpoint)} ${esc(s.raw)}`).join('<br>') || '-'}</td>
    <td>${row.extras.length ? `${row.extras.length} 条未采用` : '-'}
        ${row.voidedCount ? `，${row.voidedCount} 条作废` : ''}</td></tr>`
  ).join('');

  return `
<h2>完赛榜（${r.finishers.length} 人）</h2>
<div class="card"><table>
<thead><tr><th>名次</th><th>选手</th><th>成绩（终点-发枪）</th><th>终点时刻</th><th>各点采用记录</th><th>备注</th></tr></thead>
<tbody>${finRows || '<tr><td colspan="6" class="muted">暂无完赛者</td></tr>'}</tbody>
</table></div>
<h2>未完赛（${r.dnfs.length} 人）</h2>
<div class="card"><table>
<thead><tr><th>选手</th><th>状态</th><th>缺打卡点</th><th>已有点记录</th><th>备注</th></tr></thead>
<tbody>${dnfRows || '<tr><td colspan="5" class="muted">无</td></tr>'}</tbody>
</table></div>`;
}

function resultsPage(r) {
  if (!r.configured) {
    return `<h1>实时成绩</h1><div class="err">尚未完成赛前录入（发枪时刻 / 检查点），请先到「赛前录入」设置。</div>`;
  }
  return `
<h1>实时成绩</h1>
<div class="card muted">
  发枪时刻：${esc(r.startTime)} ｜ 检查点：${r.checkpoints.map((c) => esc(c.code)).join(' → ')} ｜
  计算时间：${esc(r.generatedAt)}<br>
  本榜为实时预览，随导入 / 作废即时重算；点击「发布」冻结当前榜单及所据事件。
</div>
${resultsTables(r)}
<form method="post" action="/publish" onsubmit="return confirm('发布后榜单与所据事件集将被冻结，确认发布？')">
  <button type="submit">发布当前榜单</button>
</form>`;
}

function publicationsPage(pubs) {
  const rows = pubs.map((p) => `
    <tr><td>#${p.id}</td><td>${esc(p.published_at)}</td>
    <td>${p.finishedCount} 完赛 / ${p.dnfCount} 未完赛</td>
    <td>${p.eventCount} 条（含作废 ${p.voidedCount}）</td>
    <td><a href="/publications/${p.id}">查看</a></td></tr>`
  ).join('');
  return `
<h1>发布历史</h1>
<div class="card"><table>
<thead><tr><th>期号</th><th>发布时间</th><th>榜单</th><th>所据事件</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="muted">尚未发布</td></tr>'}</tbody>
</table></div>`;
}

function publicationPage(pub, snap) {
  const r = snap.results;
  const evRows = snap.events.map((e) => `
    <tr${e.voided ? ' class="voided"' : ''}><td>${e.id}</td><td>${esc(e.event_no)}</td>
    <td>${esc(e.bib)}</td><td>${esc(e.checkpoint)}</td><td>${esc(e.punch_raw)}</td>
    <td>${e.voided ? '已作废' : '有效'}</td></tr>`
  ).join('');
  return `
<h1>发布 #${pub.id}</h1>
<div class="card muted">
  发布时间：${esc(pub.published_at)} ｜ 发枪时刻：${esc(r.startTime)} ｜
  榜单与所据 ${snap.events.length} 条事件已冻结，后续补传 / 作废不影响本期，仅反映到下次发布。
</div>
${resultsTables(r)}
<details class="card"><summary>所据事件全集（${snap.events.length} 条，含发布时已作废）</summary>
<table>
<thead><tr><th>ID</th><th>事件号</th><th>选手</th><th>检查点</th><th>刷卡时刻</th><th>发布时状态</th></tr></thead>
<tbody>${evRows}</tbody>
</table></details>`;
}

module.exports = {
  esc,
  fmtDuration,
  layout,
  homePage,
  setupPage,
  importPage,
  eventsPage,
  resultsPage,
  publicationsPage,
  publicationPage,
};
