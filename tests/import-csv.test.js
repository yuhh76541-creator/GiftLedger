const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../miniprogram/utils/importCsv');
const { buildCsv } = require('../miniprogram/utils/exportCsv');

test('导出的 CSV 可重新导入，空日期与多行备注得到保留', () => {
  const source = buildCsv([
    { direction: 'received', personName: '张先生', amountFen: 50050, happenedOn: '', note: '婚礼,礼金\n已登记', settled: true },
    { direction: 'given', personName: '李女士', amountFen: 10000, happenedOn: '2026-10-10', note: '' }
  ]);
  assert.deepEqual(parseCsv(source), [
    { direction: 'received', personName: '张先生', amount: '500.50', happenedOn: '', note: '婚礼,礼金\n已登记', settled: true },
    { direction: 'given', personName: '李女士', amount: '100.00', happenedOn: '2026-10-10', note: '', settled: false }
  ]);
});

test('日期列可缺省，错误金额与日期在预览前被拒绝', () => {
  assert.equal(parseCsv('姓名,收送,金额\n小余,收礼,12.50')[0].happenedOn, '');
  assert.equal(parseCsv('姓名,收送,金额\n小余,收礼,12.50')[0].settled, false);
  assert.throws(() => parseCsv('姓名,收送,金额,状态\n小余,收礼,12.50,未知'), /第 2 行.*状态/);
  assert.throws(() => parseCsv('日期,收送,往来对象,金额（元）\n2026-02-30,收礼,小余,12'), /第 2 行.*日期/);
  assert.throws(() => parseCsv('日期,收送,往来对象,金额（元）\n,收礼,小余,12.345'), /第 2 行.*金额/);
  assert.throws(() => parseCsv('日期,收送,往来对象,金额（元）\n,收礼,小余,"12'), /引号/);
});
