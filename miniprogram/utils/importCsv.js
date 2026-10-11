const MAX_IMPORT_ROWS = 500;

function parseCells(text) {
  const rows = [];
  let cells = [];
  let cell = '';
  let quoted = false;
  let endedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') { quoted = false; endedQuote = true; }
      else cell += char;
    } else if (char === ',' || char === '\n' || char === '\r') {
      cells.push(cell);
      cell = '';
      endedQuote = false;
      if (char !== ',') {
        rows.push(cells); cells = [];
        if (char === '\r' && text[index + 1] === '\n') index += 1;
      }
    } else if (char === '"' && !cell && !endedQuote) quoted = true;
    else if (endedQuote && !/\s/.test(char)) throw new Error('CSV 引号格式不正确');
    else if (char === '"') throw new Error('CSV 引号格式不正确');
    else cell += char;
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号');
  if (cell || cells.length) { cells.push(cell); rows.push(cells); }
  return rows;
}

function normalizeDate(value) {
  const raw = value.trim();
  if (!raw || raw === '未知时间') return '';
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw);
  if (!match) throw new Error('日期须为 YYYY-MM-DD，或留空');
  const result = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const date = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== result) throw new Error('日期不存在');
  return result;
}

function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('CSV 文件为空');
  const rows = parseCells(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('CSV 没有可导入的记录');
  const header = rows[0].map(value => value.trim().replace(/[()]/g, symbol => symbol === '(' ? '（' : '）'));
  const column = {
    happenedOn: header.findIndex(value => ['日期', '时间'].includes(value)),
    direction: header.findIndex(value => ['收送', '收送方向', '方向'].includes(value)),
    personName: header.findIndex(value => ['往来对象', '姓名', '人员'].includes(value)),
    amount: header.findIndex(value => ['金额（元）', '金额', '礼金金额'].includes(value)),
    note: header.findIndex(value => ['备注', '说明'].includes(value)),
    settled: header.findIndex(value => ['状态', '结清状态'].includes(value))
  };
  if (['direction', 'personName', 'amount'].some(key => column[key] < 0)) {
    throw new Error('CSV 至少需要“收送、往来对象、金额（元）”三列');
  }
  const entries = [];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    if (cells.every(value => !value.trim())) continue;
    const read = key => column[key] < 0 ? '' : String(cells[column[key]] || '').trim();
    try {
      const directionText = read('direction');
      const direction = ['收礼', '收入', '收到', 'received'].includes(directionText) ? 'received'
        : ['送礼', '支出', '送出', 'given'].includes(directionText) ? 'given' : '';
      if (!direction) throw new Error('收送方向应填写“收礼”或“送礼”');
      const personName = read('personName').replace(/^'(?=[=+\-@])/, '');
      if (!personName || Array.from(personName).length > 40) throw new Error('往来对象需为 1–40 个字符');
      const amount = read('amount').replace(/[¥￥,]/g, '');
      if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw new Error('金额须大于 0，最多两位小数');
      const note = read('note').replace(/^'(?=[=+\-@])/, '');
      if (Array.from(note).length > 200) throw new Error('备注不能超过 200 个字符');
      const status = read('settled');
      if (status && !['已结清', '未结清'].includes(status)) throw new Error('状态应填写“已结清”或“未结清”');
      entries.push({ direction, personName, amount, happenedOn: normalizeDate(read('happenedOn')), note, settled: status === '已结清' });
      if (entries.length > MAX_IMPORT_ROWS) throw new Error(`一次最多导入 ${MAX_IMPORT_ROWS} 笔`);
    } catch (error) { throw new Error(`第 ${index + 1} 行：${error.message}`); }
  }
  if (!entries.length) throw new Error('CSV 没有可导入的记录');
  return entries;
}

module.exports = { parseCsv, MAX_IMPORT_ROWS };
