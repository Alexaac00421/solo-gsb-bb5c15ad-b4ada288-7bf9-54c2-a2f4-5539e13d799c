'use strict';

/** 解析 CSV 文本为 [{ lineNo, fields }]，支持引号包裹与 "" 转义。lineNo 从 1 开始。 */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let rowLine = 1;
  let lineNo = 1;
  let inQuotes = false;

  const pushRow = () => {
    row.push(field);
    field = '';
    rows.push({ lineNo: rowLine, fields: row });
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { pushRow(); lineNo++; rowLine = lineNo; continue; }
    if (c === '\r') { continue; }
    field += c;
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

const TZ_TAIL = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * 解析带时区的时间串为 epoch 毫秒；缺少时区或格式非法返回 null。
 * 接受示例：2026-10-07T09:30:00+08:00 / 2026-10-07 09:30:00+0800 / ...Z
 */
function parseTimestamp(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || !TZ_TAIL.test(s)) return null;
  const norm = s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(norm);
  return Number.isNaN(ms) ? null : ms;
}

module.exports = { parseCsv, parseTimestamp };
