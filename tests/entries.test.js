const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let openid = 'owner-a';
const savedEntries = [];
const fakeMembers = [];
const fakeUsers = [{ _id: 'owner-a', nickname: '小余' }, { _id: 'owner-b', nickname: '阿明' }];
const fakeLedgers = [
  { _id: 'ledger-a', ownerOpenid: 'owner-a', name: '婚礼' },
  { _id: 'ledger-b', ownerOpenid: 'owner-a', name: '日常' }
];
function matches(item, query) {
  return Object.entries(query).every(([key, value]) => {
    if (value instanceof RegExp) return value.test(item[key]);
    if (value && typeof value.__match === 'function') return value.__match(item[key]);
    return item[key] === value;
  });
}
function comparison(predicate) {
  return { __match: predicate, and(other) { return comparison(value => predicate(value) && other.__match(value)); } };
}
const fakeDb = {
  serverDate: () => new Date(),
  command: { aggregate: { sum: value => value }, in: values => comparison(item => values.includes(item)), gte: value => comparison(item => item >= value), lt: value => comparison(item => item < value) },
  collection(name) {
    if (name === 'users') {
      return { where(query) { return { limit() { return { async get() { return { data: fakeUsers.filter(item => matches(item, query)) }; } }; } }; } };
    }
    if (name === 'ledgers') {
      return {
        where(query) {
          let selected = fakeLedgers.filter(item => matches(item, query));
          return {
            skip(offset) { selected = selected.slice(offset); return this; },
            limit(count) { selected = selected.slice(0, count); return this; },
            async get() { return { data: selected }; }
          };
        }
      };
    }
    if (name === 'entries') {
      return {
        async add({ data }) {
          const id = `entry-${savedEntries.length + 1}`;
          savedEntries.push({ _id: id, ...data });
          return { _id: id };
        },
        where(query) {
          let selected = savedEntries.filter(item => matches(item, query));
          return {
            orderBy() { return this; },
            skip(offset) { selected = selected.slice(offset); return this; },
            limit(count) { selected = selected.slice(0, count); return this; },
            async get() { return { data: selected }; }
          };
        },
        doc(id) {
          return {
            async set({ data }) {
              const index = savedEntries.findIndex(item => item._id === id);
              if (index >= 0) savedEntries.splice(index, 1);
              savedEntries.push({ _id: id, ...data });
            },
            async update({ data }) {
              Object.assign(savedEntries.find(item => item._id === id), data);
            },
            async remove() {
              const index = savedEntries.findIndex(item => item._id === id);
              savedEntries.splice(index, 1);
            }
          };
        },
        aggregate() {
          let query;
          return {
            match(value) {
              query = value;
              return this;
            },
            group() { return this; },
            async end() {
              const groups = ['received', 'given'].map(direction => {
                const selected = savedEntries.filter(item => matches(item, query) && item.direction === direction);
                return {
                  _id: direction,
                  totalFen: selected.reduce((sum, item) => sum + item.amountFen, 0),
                  count: selected.length
                };
              });
              return { list: groups };
            }
          };
        }
      };
    }
    if (name === 'ledgerMembers') {
      return {
        where(query) {
          return {
            limit() {
              return {
                async get() {
                  return { data: fakeMembers.filter(item => item._id === query._id) };
                }
              };
            }
          };
        }
      };
    }
    throw new Error(`Unexpected collection: ${name}`);
  }
};

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database: () => fakeDb,
  getWXContext: () => ({ OPENID: openid })
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud;
  return originalLoad.call(this, request, parent, isMain);
};
const entries = require('../cloudfunctions/entries/index');
Module._load = originalLoad;

const validEntry = {
  action: 'create',
  ledgerId: 'ledger-a',
  direction: 'received',
  personName: '张先生',
  amount: '500.50',
  happenedOn: '2026-10-10',
  note: '婚礼'
};

test('账本所有者可以保存金额，金额以分记录', async () => {
  openid = 'owner-a';
  const result = await entries.main(validEntry);
  assert.equal(result.entryId, 'entry-1');
  assert.equal(savedEntries[0].amountFen, 50050);
  assert.equal(savedEntries[0].ledgerId, 'ledger-a');
  assert.equal(savedEntries[0].createdByOpenid, 'owner-a');
});

test('其他用户不能向账本写入记录', async () => {
  openid = 'owner-b';
  const before = savedEntries.length;
  await assert.rejects(entries.main(validEntry), /无权访问/);
  await assert.rejects(entries.main({ action: 'update', ledgerId: 'ledger-a', entryId: 'entry-1' }), /无权访问/);
  await assert.rejects(entries.main({ action: 'delete', ledgerId: 'ledger-a', entryId: 'entry-1' }), /无权访问/);
  await assert.rejects(entries.main({ action: 'setSettled', ledgerId: 'ledger-a', entryId: 'entry-1', settled: true }), /无权访问/);
  await assert.rejects(entries.main({ action: 'summary', ledgerId: 'ledger-a' }), /无权访问/);
  assert.equal(savedEntries.length, before);
});

test('加入的编辑成员可以读写共享账本，但仍不能访问别的账本', async () => {
  fakeMembers.push({ _id: 'ledger-a_owner-b', role: 'editor' });
  openid = 'owner-b';
  const summary = await entries.main({ action: 'summary', ledgerId: 'ledger-a' });
  assert.equal(summary.receivedFen, 50050);
  const created = await entries.main({ ...validEntry, personName: '共享成员' });
  assert.equal(savedEntries.find(item => item._id === created.entryId).createdByOpenid, 'owner-b');
  await assert.rejects(entries.main({ action: 'summary', ledgerId: 'ledger-b' }), /无权访问/);
  await entries.main({ action: 'delete', ledgerId: 'ledger-a', entryId: created.entryId });
  fakeMembers[0].status = 'removed';
  await assert.rejects(entries.main({ action: 'summary', ledgerId: 'ledger-a' }), /无权访问/);
  fakeMembers.pop();
});

test('主动退出的共享成员不能继续查看归类或明细', async () => {
  fakeMembers.push({ _id: 'ledger-a_owner-b', role: 'editor', status: 'left' });
  openid = 'owner-b';
  await assert.rejects(entries.main({ action: 'groupList', ledgerId: 'ledger-a' }), /无权访问/);
  await assert.rejects(entries.main({ action: 'personPage', ledgerId: 'ledger-a', personName: '张先生' }), /无权访问/);
  fakeMembers.pop();
});

test('只能修改所属账本的记录，统计会随修改和删除更新', async () => {
  openid = 'owner-a';
  await assert.rejects(entries.main({
    ...validEntry,
    action: 'update',
    ledgerId: 'ledger-b',
    entryId: 'entry-1'
  }), /不属于该账本/);

  await entries.main({ ...validEntry, action: 'update', entryId: 'entry-1', direction: 'given', amount: '300' });
  assert.equal(savedEntries[0].amountFen, 30000);
  assert.equal(savedEntries[0].createdByOpenid, 'owner-a');
  let summary = await entries.main({ action: 'summary', ledgerId: 'ledger-a' });
  assert.equal(summary.givenFen, 30000);
  assert.equal(summary.givenCount, 1);

  await entries.main({ action: 'delete', ledgerId: 'ledger-a', entryId: 'entry-1' });
  summary = await entries.main({ action: 'summary', ledgerId: 'ledger-a' });
  assert.equal(summary.givenFen, 0);
  assert.equal(summary.givenCount, 0);
});

test('无效金额和不存在的日期会被拒绝', async () => {
  openid = 'owner-a';
  const before = savedEntries.length;
  await assert.rejects(entries.main({ ...validEntry, amount: '12.345' }), /金额/);
  await assert.rejects(entries.main({ ...validEntry, happenedOn: '2026-02-30' }), /日期/);
  assert.equal(savedEntries.length, before);
});

test('导出分页仅包含有权限账本的完整记录', async () => {
  openid = 'owner-a';
  const first = await entries.main(validEntry);
  const second = await entries.main({ ...validEntry, personName: '李女士', direction: 'given', amount: '100' });
  await entries.main({ ...validEntry, ledgerId: 'ledger-b', personName: '其他账本' });
  const result = await entries.main({ action: 'exportPage', ledgerId: 'ledger-a', offset: 0 });
  assert.equal(result.ledgerName, '婚礼');
  assert.deepEqual(result.entries.map(item => item.id), [first.entryId, second.entryId]);
  assert.equal(result.entries[0].amountFen, 50050);
  assert.equal(result.hasMore, false);
  openid = 'owner-b';
  await assert.rejects(entries.main({ action: 'exportPage', ledgerId: 'ledger-a' }), /无权访问/);
});

test('按日、按月和姓名筛选全部记录，统计与列表一致', async () => {
  openid = 'owner-a';
  const created = [];
  created.push((await entries.main({ ...validEntry, personName: '张先生', happenedOn: '2026-12-31', amount: '10' })).entryId);
  created.push((await entries.main({ ...validEntry, personName: '张女士', happenedOn: '2027-01-01', amount: '20' })).entryId);
  created.push((await entries.main({ ...validEntry, personName: '李女士', happenedOn: '2027-01-15', amount: '30', direction: 'given' })).entryId);
  const day = await entries.main({ action: 'list', ledgerId: 'ledger-a', filterMode: 'day', filterDate: '2027-01-01', nameQuery: '张' });
  assert.deepEqual(day.entries.map(item => item.id), [created[1]]);
  const month = await entries.main({ action: 'list', ledgerId: 'ledger-a', filterMode: 'month', filterDate: '2027-01-15' });
  assert.deepEqual(month.entries.map(item => item.id), created.slice(1));
  const summary = await entries.main({ action: 'summary', ledgerId: 'ledger-a', filterMode: 'month', filterDate: '2027-01-15', nameQuery: '张' });
  assert.equal(summary.receivedFen, 2000);
  assert.equal(summary.givenFen, 0);
  assert.equal(summary.receivedCount, 1);
  const literal = await entries.main({ action: 'list', ledgerId: 'ledger-a', nameQuery: '张.*' });
  assert.equal(literal.entries.length, 0);
});

test('旧记录可按全拼及拼音首字母模糊搜索，统计与列表一致', async () => {
  openid = 'owner-a';
  const created = await entries.main({ ...validEntry, personName: '张三', happenedOn: '2027-02-01', amount: '88' });
  for (const nameQuery of ['zhangsan', 'zs', 'ZHANG', 'san']) {
    const filter = { ledgerId: 'ledger-a', filterMode: 'month', filterDate: '2027-02-12', nameQuery };
    const list = await entries.main({ action: 'list', ...filter });
    const summary = await entries.main({ action: 'summary', ...filter });
    assert.deepEqual(list.entries.map(item => item.id), [created.entryId]);
    assert.equal(summary.receivedFen, 8800);
    assert.equal(summary.receivedCount, list.entries.length);
  }
});

test('拼音模糊搜索可继续翻页，不重复遗漏记录', async () => {
  openid = 'owner-a';
  const created = [];
  try {
    for (let index = 0; index < 23; index += 1) {
      created.push((await entries.main({ ...validEntry, personName: `张三${index}`, happenedOn: '2027-03-01' })).entryId);
    }
    const filter = { action: 'list', ledgerId: 'ledger-a', filterMode: 'month', filterDate: '2027-03-01', nameQuery: 'zs' };
    const first = await entries.main(filter);
    const second = await entries.main({ ...filter, offset: first.nextOffset });
    assert.equal(first.entries.length, 20);
    assert.equal(first.hasMore, true);
    assert.equal(second.entries.length, 3);
    assert.equal(second.hasMore, false);
    assert.deepEqual(new Set(first.entries.concat(second.entries).map(item => item.id)), new Set(created));
  } finally {
    for (const id of created) await entries.main({ action: 'delete', ledgerId: 'ledger-a', entryId: id });
  }
});

test('记录列表显示原添加人昵称，修改者不覆盖添加人', async () => {
  openid = 'owner-a';
  const created = await entries.main({ ...validEntry, personName: '添加人测试' });
  fakeMembers.push({ _id: 'ledger-a_owner-b', role: 'editor' });
  try {
    openid = 'owner-b';
    await entries.main({ ...validEntry, action: 'update', entryId: created.entryId, personName: '添加人测试', note: '成员改过' });
    const list = await entries.main({ action: 'list', ledgerId: 'ledger-a', nameQuery: '添加人测试' });
    assert.equal(list.entries[0].createdByLabel, '小余（尾号 wner-a）');
  } finally { fakeMembers.pop(); }
});

test('同名往来显示最近一笔，结清状态可撤销且记录保留', async () => {
  openid = 'owner-a';
  const created = [];
  try {
    created.push((await entries.main({ ...validEntry, personName: '同名测试', amount: '100', happenedOn: '' })).entryId);
    created.push((await entries.main({ ...validEntry, personName: '同名测试', direction: 'given', amount: '30', happenedOn: '2027-04-01' })).entryId);
    created.push((await entries.main({ ...validEntry, personName: '同名测试', amount: '20', happenedOn: '2027-04-02' })).entryId);
    const groups = await entries.main({ action: 'groupList', ledgerId: 'ledger-a', nameQuery: '同名测试' });
    assert.equal(groups.groups.length, 1);
    assert.equal(groups.groups[0].count, 3);
    assert.deepEqual(groups.groups[0].latest, { direction: 'received', amountFen: 2000, happenedOn: '2027-04-02', returnForEntryId: '', settled: false });
    const detail = await entries.main({ action: 'personPage', ledgerId: 'ledger-a', personName: '同名测试' });
    assert.deepEqual(detail.entries.map(item => item.amountFen), [2000, 3000, 10000]);
    assert.equal(detail.entries[2].happenedOn, '');
    assert.ok(detail.entries.every(item => item.settled === false));
    await assert.rejects(entries.main({ action: 'setSettled', ledgerId: 'ledger-a', entryId: created[2], settled: 'true' }), /无效的结清状态/);
    await assert.rejects(entries.main({ action: 'setSettled', ledgerId: 'ledger-b', entryId: created[2], settled: true }), /记录不存在或不属于该账本/);
    await entries.main({ action: 'setSettled', ledgerId: 'ledger-a', entryId: created[2], settled: true });
    const markedGroups = await entries.main({ action: 'groupList', ledgerId: 'ledger-a', nameQuery: '同名测试' });
    assert.equal(markedGroups.groups[0].latest.settled, true);
    const markedDetail = await entries.main({ action: 'personPage', ledgerId: 'ledger-a', personName: '同名测试' });
    assert.equal(markedDetail.entries[0].settled, true);
    assert.equal(markedDetail.totalCount, 3);
    await entries.main({ action: 'setSettled', ledgerId: 'ledger-a', entryId: created[2], settled: false });
    assert.equal((await entries.main({ action: 'personPage', ledgerId: 'ledger-a', personName: '同名测试' })).entries[0].settled, false);
    const day = await entries.main({ action: 'groupList', ledgerId: 'ledger-a', filterMode: 'day', filterDate: '2027-04-01', nameQuery: '同名测试' });
    assert.equal(day.groups[0].count, 1);
  } finally {
    for (const entryId of created) await entries.main({ action: 'delete', ledgerId: 'ledger-a', entryId });
  }
});

test('收礼可关联其他自有账本的回礼，保留实际金额且删除回礼后恢复待回礼', async () => {
  openid = 'owner-a';
  const receiptId = (await entries.main({ ...validEntry, personName: '跨账本回礼', amount: '500' })).entryId;
  let returnId;
  try {
    const choices = await entries.main({ action: 'returnLedgerChoices', ledgerId: 'ledger-a' });
    assert.deepEqual(choices.ledgers.map(item => item.id), ['ledger-a', 'ledger-b']);
    const result = await entries.main({ action: 'createReturn', ledgerId: 'ledger-a', receivedEntryId: receiptId, targetLedgerId: 'ledger-b', amount: '600', happenedOn: '2027-05-01', note: '对方酒席' });
    returnId = result.entryId;
    assert.equal(savedEntries.find(item => item._id === returnId).amountFen, 60000);
    assert.equal(savedEntries.find(item => item._id === returnId).returnForEntryId, receiptId);
    const exportedReceipt = await entries.main({ action: 'exportPage', ledgerId: 'ledger-a' });
    assert.equal(exportedReceipt.entries.find(item => item.id === receiptId).returned, true);
    const exportedReturn = await entries.main({ action: 'exportPage', ledgerId: 'ledger-b' });
    assert.equal(exportedReturn.entries.find(item => item.id === returnId).returnForEntryId, receiptId);
    const group = await entries.main({ action: 'groupList', ledgerId: 'ledger-a', nameQuery: '跨账本回礼' });
    assert.equal(group.groups[0].pendingCount, 0);
    assert.deepEqual(group.groups[0].latestReceived, { amountFen: 50000, happenedOn: '2026-10-10' });
    assert.deepEqual(group.groups[0].latestReturn, { amountFen: 60000, happenedOn: '2027-05-01' });
    const detail = await entries.main({ action: 'personPage', ledgerId: 'ledger-a', personName: '跨账本回礼' });
    assert.equal(detail.totalCount, 2);
    assert.equal(detail.entries.find(item => item.id === receiptId).returned, true);
    assert.equal(detail.entries.find(item => item.id === returnId).ledgerName, '日常');
    await assert.rejects(entries.main({ action: 'delete', ledgerId: 'ledger-a', entryId: receiptId }), /先删除关联的回礼/);
    await assert.rejects(entries.main({ ...validEntry, action: 'update', ledgerId: 'ledger-b', entryId: returnId, personName: '别人' }), /不能更改往来对象/);
    await entries.main({ action: 'delete', ledgerId: 'ledger-b', entryId: returnId });
    returnId = '';
    const after = await entries.main({ action: 'groupList', ledgerId: 'ledger-a', nameQuery: '跨账本回礼' });
    assert.equal(after.groups[0].pendingCount, 1);
    assert.equal(after.groups[0].latestReturn, null);
    const exportedAfterDelete = await entries.main({ action: 'exportPage', ledgerId: 'ledger-a' });
    assert.equal(exportedAfterDelete.entries.find(item => item.id === receiptId).returned, false);
  } finally {
    if (returnId) await entries.main({ action: 'delete', ledgerId: 'ledger-b', entryId: returnId });
    await entries.main({ action: 'delete', ledgerId: 'ledger-a', entryId: receiptId });
  }
});

test('普通送礼不自动充当回礼，共享成员不能借回礼查看其他账本', async () => {
  openid = 'owner-a';
  const receiptId = (await entries.main({ ...validEntry, personName: '独立关联测试' })).entryId;
  const giftId = (await entries.main({ ...validEntry, action: 'create', ledgerId: 'ledger-b', direction: 'given', personName: '独立关联测试', amount: '600' })).entryId;
  fakeMembers.push({ _id: 'ledger-a_owner-b', role: 'editor' });
  try {
    const group = await entries.main({ action: 'groupList', ledgerId: 'ledger-a', nameQuery: '独立关联测试' });
    assert.equal(group.groups[0].pendingCount, 1);
    assert.equal(group.groups[0].latestReturn, null);
    const archive = await entries.main({ action: 'personPage', ledgerId: 'ledger-a', personName: '独立关联测试' });
    assert.equal(archive.archiveScope, true);
    assert.deepEqual(new Set(archive.entries.map(item => item.ledgerName)), new Set(['婚礼', '日常']));
    const candidates = await entries.main({ action: 'returnCandidates', ledgerId: 'ledger-a', receivedEntryId: receiptId });
    assert.equal(candidates.candidates[0].id, giftId);
    await entries.main({ action: 'linkExistingReturn', ledgerId: 'ledger-a', receivedEntryId: receiptId, targetLedgerId: 'ledger-b', returnEntryId: giftId });
    assert.equal((await entries.main({ action: 'groupList', ledgerId: 'ledger-a', nameQuery: '独立关联测试' })).groups[0].pendingCount, 0);
    assert.equal((await entries.main({ action: 'returnCandidates', ledgerId: 'ledger-a', receivedEntryId: receiptId })).candidates.length, 0);
    await assert.rejects(entries.main({ action: 'linkExistingReturn', ledgerId: 'ledger-a', receivedEntryId: receiptId, targetLedgerId: 'ledger-b', returnEntryId: giftId }), /已关联/);
    await entries.main({ action: 'unlinkReturn', ledgerId: 'ledger-a', receivedEntryId: receiptId, targetLedgerId: 'ledger-b', returnEntryId: giftId });
    assert.equal((await entries.main({ action: 'groupList', ledgerId: 'ledger-a', nameQuery: '独立关联测试' })).groups[0].pendingCount, 1);
    assert.equal(savedEntries.find(item => item._id === giftId).amountFen, 60000);
    openid = 'owner-b';
    const choices = await entries.main({ action: 'returnLedgerChoices', ledgerId: 'ledger-a' });
    assert.deepEqual(choices.ledgers.map(item => item.id), ['ledger-a']);
    const sharedArchive = await entries.main({ action: 'personPage', ledgerId: 'ledger-a', personName: '独立关联测试' });
    assert.equal(sharedArchive.archiveScope, false);
    assert.equal(sharedArchive.totalCount, 1);
    await assert.rejects(entries.main({ action: 'createReturn', ledgerId: 'ledger-a', receivedEntryId: receiptId, targetLedgerId: 'ledger-b', amount: '600', happenedOn: '2027-05-01' }), /无权访问/);
  } finally {
    openid = 'owner-a';
    fakeMembers.pop();
    await entries.main({ action: 'delete', ledgerId: 'ledger-b', entryId: giftId });
    await entries.main({ action: 'delete', ledgerId: 'ledger-a', entryId: receiptId });
  }
});

test('CSV 批量导入逐批幂等，空日期可保存且无权账本不能导入', async () => {
  openid = 'owner-a';
  const importId = 'a'.repeat(32);
  const batch = { action: 'importBatch', ledgerId: 'ledger-a', importId, startIndex: 0, rows: [
    { direction: 'received', personName: '导入测试', amount: '50.00', happenedOn: '', note: '无日期' },
    { direction: 'given', personName: '导入测试', amount: '10', happenedOn: '2027-04-03', note: '', settled: true }
  ] };
  const first = await entries.main(batch);
  const again = await entries.main(batch);
  assert.deepEqual(first, { imported: 2, skipped: 0 });
  assert.deepEqual(again, { imported: 0, skipped: 2 });
  const imported = savedEntries.filter(item => item.personName === '导入测试');
  assert.equal(imported.length, 2);
  assert.equal(imported[0].happenedOn, '');
  assert.deepEqual(imported.map(item => item.settled), [false, true]);
  await assert.rejects(entries.main({ ...batch, startIndex: 2, rows: [{ ...batch.rows[0], amount: '0' }] }), /金额/);
  openid = 'owner-b';
  await assert.rejects(entries.main(batch), /无权访问/);
  openid = 'owner-a';
  for (const item of imported) await entries.main({ action: 'delete', ledgerId: 'ledger-a', entryId: item._id });
});

test('无效筛选参数被拒绝，导出不受筛选条件影响', async () => {
  openid = 'owner-a';
  await assert.rejects(entries.main({ action: 'list', ledgerId: 'ledger-a', filterMode: 'week' }), /筛选/);
  await assert.rejects(entries.main({ action: 'summary', ledgerId: 'ledger-a', filterMode: 'day', filterDate: '2027-02-30' }), /日期/);
  await assert.rejects(entries.main({ action: 'list', ledgerId: 'ledger-a', nameQuery: '张'.repeat(41) }), /40/);
  const exported = await entries.main({ action: 'exportPage', ledgerId: 'ledger-a', offset: 0, filterMode: 'day', filterDate: '2027-01-01' });
  assert.ok(exported.entries.length > 1);
});

test('已删除账本的记录无法再读取、添加或导出', async () => {
  openid = 'owner-a';
  fakeLedgers[1].deletedAt = new Date();
  try {
    await assert.rejects(entries.main({ action: 'list', ledgerId: 'ledger-b' }), /无权访问/);
    await assert.rejects(entries.main({ ...validEntry, ledgerId: 'ledger-b' }), /无权访问/);
    await assert.rejects(entries.main({ action: 'exportPage', ledgerId: 'ledger-b' }), /无权访问/);
  } finally { delete fakeLedgers[1].deletedAt; }
});
