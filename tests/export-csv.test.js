const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCsv } = require('../miniprogram/utils/exportCsv');

test('CSV 含中文 BOM、分金额、引号与换行正确转义', () => {
  const csv = buildCsv([{
    direction: 'received', personName: '张"先生', amountFen: 50050,
    happenedOn: '2026-10-10', note: '婚礼,礼金\n已登记', settled: true
  }]);
  assert.ok(csv.startsWith('\uFEFF"日期","收送","往来对象","金额（元）","备注","状态","回礼情况"\r\n'));
  assert.ok(csv.includes('"张""先生",500.50,"婚礼,礼金\n已登记"'));
  assert.ok(csv.includes('"已结清"'));
  assert.ok(csv.includes('"此前手动标记结清（未登记回礼金额）"'));
  assert.ok(csv.endsWith('\r\n'));
});

test('已登记回礼、旧结清标记与普通送礼在 CSV 中明确区分', () => {
  const csv = buildCsv([
    { direction: 'received', personName: '甲', amountFen: 50000, happenedOn: '', returned: true, settled: false },
    { direction: 'received', personName: '乙', amountFen: 30000, happenedOn: '', settled: true },
    { direction: 'received', personName: '丙', amountFen: 20000, happenedOn: '', settled: false },
    { direction: 'given', personName: '甲', amountFen: 60000, happenedOn: '', returnForEntryId: 'receipt-1' },
    { direction: 'given', personName: '丁', amountFen: 10000, happenedOn: '' }
  ]);
  assert.ok(csv.includes('"甲",500.00,"","已结清","已登记回礼"'));
  assert.ok(csv.includes('"乙",300.00,"","已结清","此前手动标记结清（未登记回礼金额）"'));
  assert.ok(csv.includes('"丙",200.00,"","未结清","待回礼"'));
  assert.ok(csv.includes('"甲",600.00,"","","已关联收礼记录"'));
  assert.ok(csv.includes('"丁",100.00,"","","普通送礼"'));
});

test('CSV 用户文本不能作为表格公式执行', () => {
  const csv = buildCsv([{
    direction: 'given', personName: '=HYPERLINK("bad")', amountFen: 1,
    happenedOn: '2026-10-10', note: '  +1+2'
  }]);
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"\'  +1+2"'));
  assert.ok(csv.includes(',0.01,'));
});

test('异常金额会拒绝导出而非产生错误文件', () => {
  assert.throws(() => buildCsv([{
    direction: 'received', personName: '张先生', amountFen: NaN,
    happenedOn: '2026-10-10', note: ''
  }]), /数据异常/);
});
