const HEADERS = ['日期', '收送', '往来对象', '金额（元）', '备注', '状态', '回礼情况'];

function csvTextCell(value) {
  let text = String(value == null ? '' : value);
  // CSV 被 Excel 等表格软件打开时，用户输入的文本不能被当作公式执行。
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(entries) {
  if (!Array.isArray(entries)) throw new Error('导出记录格式不正确');
  const lines = [HEADERS.map(csvTextCell).join(',')];
  entries.forEach(item => {
    if ((item.direction !== 'received' && item.direction !== 'given') ||
      !Number.isSafeInteger(item.amountFen) || item.amountFen <= 0 ||
      typeof item.happenedOn !== 'string' || typeof item.personName !== 'string') {
      throw new Error('记录数据异常，未生成导出文件');
    }
    const isReceived = item.direction === 'received';
    const status = isReceived ? (item.returned || item.settled ? '已结清' : '未结清') : '';
    const returnDetail = isReceived
      ? item.returned ? '已登记回礼' : item.settled ? '此前手动标记结清（未登记回礼金额）' : '待回礼'
      : item.returnForEntryId ? '已关联收礼记录' : '普通送礼';
    lines.push([
      csvTextCell(item.happenedOn),
      csvTextCell(isReceived ? '收礼' : '送礼'),
      csvTextCell(item.personName),
      (item.amountFen / 100).toFixed(2),
      csvTextCell(item.note || ''),
      csvTextCell(status),
      csvTextCell(returnDetail)
    ].join(','));
  });
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

module.exports = { buildCsv };
