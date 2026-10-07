'use strict';
// 极简 CSV 解析（支持引号字段、引号转义、CRLF/LF、BOM）
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
      started = true;
    } else if (c === ',') {
      row.push(field); field = ''; started = false;
    } else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field); rows.push(row);
      field = ''; row = []; started = false;
    } else if (c === '\n') {
      row.push(field); rows.push(row);
      field = ''; row = []; started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (field.length > 0 || row.length > 0 || started) { row.push(field); rows.push(row); }
  return rows;
}

module.exports = { parseCsv };
