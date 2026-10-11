const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadPage(path) {
  let definition;
  global.Page = value => { definition = value; };
  require(path);
  delete global.Page;
  return definition;
}

const ledgerDefinition = loadPage('../miniprogram/pages/ledger/index');
const entryDefinition = loadPage('../miniprogram/pages/entry/index');
const mineDefinition = loadPage('../miniprogram/pages/mine/index');
const personDefinition = loadPage('../miniprogram/pages/person/index');
const returnLinkDefinition = loadPage('../miniprogram/pages/return-link/index');

function makePage(definition, data = {}) {
  return {
    ...definition,
    data: { ...definition.data, ledgerId: 'ledger-a', ledgerName: '婚礼', ...data },
    setData(patch) { Object.assign(this.data, patch); }
  };
}

function mockSelectedLedger() {
  global.getApp = () => ({ globalData: { openid: 'openid-a' } });
  return () => { delete global.getApp; };
}

test('金额含三位小数时在本地拦截，不调用云函数', async () => {
  const cleanup = mockSelectedLedger();
  let calls = 0;
  global.wx = {
    getStorageSync: () => ({ id: 'ledger-a', name: '婚礼' }),
    cloud: { callFunction: async () => { calls += 1; } }
  };
  const page = makePage(entryDefinition, { personName: '余先生', amount: '1.855' });
  await page.createEntry();
  assert.equal(page.data.formError, '金额最多保留两位小数。');
  assert.equal(calls, 0);
  delete global.wx; cleanup();
});

test('零金额在本地拦截，不调用云函数', async () => {
  const cleanup = mockSelectedLedger();
  let calls = 0;
  global.wx = {
    getStorageSync: () => ({ id: 'ledger-a', name: '婚礼' }),
    cloud: { callFunction: async () => { calls += 1; } }
  };
  const page = makePage(entryDefinition, { personName: '余先生', amount: '0' });
  await page.createEntry();
  assert.equal(page.data.formError, '金额必须大于 0 元。');
  assert.equal(calls, 0);
  delete global.wx; cleanup();
});

test('独立记账页保存后返回往来列表', async () => {
  const cleanup = mockSelectedLedger();
  let submitted;
  let backCount = 0;
  global.wx = {
    getStorageSync: () => ({ id: 'ledger-a', name: '婚礼' }),
    cloud: { callFunction: async request => { submitted = request; return { result: { entryId: 'entry-a' } }; } },
    showToast: () => {}, navigateBack: () => { backCount += 1; }
  };
  const page = makePage(entryDefinition, { personName: '余先生', amount: '500.00' });
  await page.createEntry();
  assert.equal(submitted.data.action, 'create');
  assert.equal(submitted.data.ledgerId, 'ledger-a');
  assert.equal(backCount, 1);
  delete global.wx; cleanup();
});

test('编辑页未收到原记录时不能提交', async () => {
  const cleanup = mockSelectedLedger();
  let calls = 0;
  global.wx = {
    getStorageSync: () => ({ id: 'ledger-a', name: '婚礼' }),
    cloud: { callFunction: async () => { calls += 1; } }
  };
  const page = makePage(entryDefinition, { editingId: 'entry-a', editReady: false, personName: '余先生', amount: '500.00' });
  await page.createEntry();
  assert.equal(calls, 0);
  delete global.wx; cleanup();
});

test('同名往来整行点开明细页，列表不再放编辑和删除按钮', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/ledger/index.wxml'), 'utf8');
  assert.match(markup, /class="entry-row touchable"[^>]*bindtap="openPerson"/);
  assert.doesNotMatch(markup, /class="entry-actions"|bindtap="deleteEntry"/);
  assert.match(markup, /共 \{\{item.count\}\} 笔往来/);
  let opened;
  global.wx = { navigateTo(options) { opened = options.url; } };
  const page = makePage(ledgerDefinition, { entries: [{ personName: '余先生', count: 2 }] });
  page.openPerson({ currentTarget: { dataset: { name: '余先生' } } });
  assert.match(opened, /personName=%E4%BD%99%E5%85%88%E7%94%9F/);
  delete global.wx;
});

test('编辑页取消删除时不会调用云函数', async () => {
  const cleanup = mockSelectedLedger();
  let calls = 0;
  global.wx = {
    getStorageSync: () => ({ id: 'ledger-a', name: '婚礼' }),
    showModal: ({ success }) => success({ confirm: false }),
    cloud: { callFunction: async () => { calls += 1; } }
  };
  const page = makePage(entryDefinition, { editingId: 'entry-1', editReady: true, personName: '余先生' });
  await page.deleteEntry();
  assert.equal(calls, 0);
  delete global.wx; cleanup();
});

test('编辑页确认删除后调用云函数并返回列表', async () => {
  const cleanup = mockSelectedLedger();
  let request;
  let backCount = 0;
  global.wx = {
    getStorageSync: () => ({ id: 'ledger-a', name: '婚礼' }),
    showModal: ({ success }) => success({ confirm: true }),
    cloud: { callFunction: async options => { request = options; return { result: { deleted: true } }; } },
    showToast: () => {}, navigateBack: () => { backCount += 1; }
  };
  const page = makePage(entryDefinition, { editingId: 'entry-1', editReady: true, personName: '余先生' });
  await page.deleteEntry();
  assert.deepEqual(request.data, { action: 'delete', ledgerId: 'ledger-a', entryId: 'entry-1' });
  assert.equal(backCount, 1);
  delete global.wx; cleanup();
});

test('日期与姓名条件同时传给列表和统计，分页继续沿用条件', async () => {
  const requests = [];
  global.wx = { cloud: { callFunction: async request => {
    requests.push(request.data);
    if (request.data.action === 'summary') return { result: { receivedFen: 1000, givenFen: 0, receivedCount: 1, givenCount: 0 } };
    return { result: { groups: [{ personName: '张女士', count: 1, latest: { direction: 'received', amountFen: 1000, happenedOn: '2026-10-10', settled: false } }], totalGroups: 1, nextOffset: request.data.offset + 1, hasMore: request.data.offset === 0 } };
  } } };
  const page = makePage(ledgerDefinition, { filterMode: 'month', filterDate: '2026-10-10', searchName: '张' });
  await page.refreshEntries();
  await page.loadMore();
  assert.deepEqual(requests.map(item => item.action), ['groupList', 'summary', 'groupList']);
  requests.forEach(item => assert.deepEqual([item.filterMode, item.filterDate, item.nameQuery], ['month', '2026-10-10', '张']));
  assert.equal(requests[2].offset, 1);
  assert.equal(page.data.totalCount, 1);
  delete global.wx;
});

test('快速切换筛选时旧请求不会覆盖新结果', async () => {
  const pending = [];
  global.wx = { cloud: { callFunction: request => new Promise(resolve => pending.push({ data: request.data, resolve })) } };
  const page = makePage(ledgerDefinition);
  const oldRefresh = page.refreshEntries();
  const newRefresh = page.chooseFilterMode({ currentTarget: { dataset: { mode: 'day' } } });
  assert.equal(pending.length, 4);
  pending.filter(item => item.data.filterMode === 'day').forEach(item => item.resolve({ result: item.data.action === 'summary'
    ? { receivedFen: 2000, givenFen: 0, receivedCount: 1, givenCount: 0 }
    : { groups: [{ personName: '新记录', count: 1, latest: { direction: 'received', amountFen: 2000, happenedOn: '2026-10-10', settled: false } }], totalGroups: 1, nextOffset: 1, hasMore: false } }));
  await newRefresh;
  pending.filter(item => item.data.filterMode === 'all').forEach(item => item.resolve({ result: item.data.action === 'summary'
    ? { receivedFen: 1000, givenFen: 0, receivedCount: 1, givenCount: 0 }
    : { groups: [{ personName: '旧记录', count: 1, latest: { direction: 'received', amountFen: 1000, happenedOn: '2026-10-10', settled: false } }], totalGroups: 1, nextOffset: 1, hasMore: false } }));
  await oldRefresh;
  assert.deepEqual(page.data.entries.map(item => item.personName), ['新记录']);
  assert.equal(page.data.summary.receivedYuan, '20.00');
  delete global.wx;
});

test('月份选择器返回年月时转换为该月日期用于云端筛选', async () => {
  const filters = [];
  global.wx = { cloud: { callFunction: async ({ data }) => {
    filters.push(data);
    return { result: data.action === 'summary'
      ? { receivedFen: 0, givenFen: 0, receivedCount: 0, givenCount: 0 }
      : { groups: [], totalGroups: 0, nextOffset: 0, hasMore: false } };
  } } };
  const page = makePage(ledgerDefinition, { filterMode: 'month' });
  await page.onFilterDateChange({ detail: { value: '2027-02' } });
  assert.equal(page.data.filterDate, '2027-02-01');
  assert.equal(page.data.filterDateLabel, '2027-02');
  assert.ok(filters.every(item => item.filterDate === '2027-02-01'));
  delete global.wx;
});

test('人员明细显示原随礼与关联回礼，可进入记录回礼或编辑原记录', async () => {
  let opened;
  let emitted;
  global.wx = {
    cloud: { callFunction: async () => ({ result: { entries: [{ id: 'entry-a', ledgerId: 'ledger-a', ledgerName: '婚礼', direction: 'received', personName: '小余', amountFen: 3000, settled: false, happenedOn: '', note: '测试', returnCount: 1, latestReturn: { amountFen: 4000, happenedOn: '2027-05-01' } }], totalCount: 1, nextOffset: 1, hasMore: false } }) },
    navigateTo(options) { opened = options.url; if (options.success) options.success({ eventChannel: { emit(name, entry) { emitted = { name, entry }; } } }); }
  };
  const page = makePage(personDefinition, { personName: '小余' });
  await page.refreshEntries();
  assert.equal(page.data.entries[0].dateLabel, '未知时间');
  assert.equal(page.data.entries[0].amountYuan, '30.00');
  assert.equal(page.data.entries[0].latestReturnYuan, '40.00');
  page.recordReturn({ currentTarget: { dataset: { id: 'entry-a' } } });
  assert.match(opened, /returnForEntryId=entry-a/);
  page.startEdit({ currentTarget: { dataset: { id: 'entry-a' } } });
  assert.match(opened, /entryId=entry-a/);
  assert.equal(emitted.entry.id, 'entry-a');
  delete global.wx;
});

test('回礼操作按钮受卡片宽度约束，不再各自占满整行', () => {
  const styles = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/person/index.wxss'), 'utf8');
  assert.match(styles, /\.return-actions\s*\{[^}]*width:\s*100%/);
  assert.match(styles, /\.return-actions button\s*\{[^}]*flex:\s*1 1 0;[^}]*width:\s*0;[^}]*min-width:\s*0;/);
  assert.doesNotMatch(styles, /\.return-button\s*\{[^}]*flex:\s*none/);
});

test('关联回礼在另一本账本时仍可从收礼明细进入编辑', () => {
  let opened;
  global.wx = { navigateTo(options) { opened = options.url; options.success({ eventChannel: { emit() {} } }); } };
  const page = makePage(personDefinition, { entries: [{ id: 'return-a', ledgerId: 'ledger-b', personName: '小余' }] });
  page.startEdit({ currentTarget: { dataset: { id: 'return-a' } } });
  assert.match(opened, /ledgerId=ledger-b/);
  assert.match(opened, /contextLedgerId=ledger-a/);
  delete global.wx;
});

test('记录回礼表单可选择另一本账本，保存实际金额和原收礼关联', async () => {
  const cleanup = mockSelectedLedger();
  let saved;
  global.wx = {
    getStorageSync: () => ({ id: 'ledger-a', name: '婚礼' }),
    cloud: { callFunction: async request => {
      if (request.data.action === 'returnLedgerChoices') return { result: { ledgers: [{ id: 'ledger-a', name: '婚礼' }, { id: 'ledger-b', name: '日常' }] } };
      saved = request.data;
      return { result: { entryId: 'return-1' } };
    } },
    showToast: () => {}, navigateBack: () => {}
  };
  const page = makePage(entryDefinition);
  page.onLoad({ ledgerId: 'ledger-a', returnForEntryId: 'receipt-1', personName: encodeURIComponent('张先生'), receivedAmountFen: '50000', receivedDate: '2026-10-10' });
  await page.loadReturnLedgers();
  page.onTargetLedgerChange({ detail: { value: '1' } });
  page.setData({ amount: '600', note: '对方酒席' });
  await page.createEntry();
  assert.deepEqual([saved.action, saved.ledgerId, saved.targetLedgerId, saved.receivedEntryId, saved.personName, saved.amount], ['createReturn', 'ledger-a', 'ledger-b', 'receipt-1', '张先生', '600']);
  delete global.wx; cleanup();
});

test('已有送礼关联时不重复新增记录，取消关联保留原送礼', async () => {
  const cleanup = mockSelectedLedger();
  const calls = [];
  let backCount = 0;
  global.wx = {
    getStorageSync: () => ({ id: 'ledger-a', name: '婚礼' }),
    cloud: { callFunction: async ({ data }) => {
      calls.push(data);
      if (data.action === 'returnCandidates') return { result: { candidates: [{ id: 'gift-1', ledgerId: 'ledger-b', ledgerName: '日常', amountFen: 60000, happenedOn: '2027-05-01' }], nextOffset: 1, hasMore: false } };
      return { result: data.action === 'linkExistingReturn' ? { linked: true } : { unlinked: true } };
    } },
    showModal: ({ success }) => success({ confirm: true }),
    showToast: () => {}, navigateBack: () => { backCount += 1; }
  };
  const page = makePage(returnLinkDefinition, { contextLedgerId: 'ledger-a', receivedEntryId: 'receipt-1', personName: '张先生' });
  await page.refreshCandidates();
  await page.chooseCandidate({ currentTarget: { dataset: { id: 'gift-1' } } });
  assert.equal(calls[1].action, 'linkExistingReturn');
  assert.equal(calls[1].returnEntryId, 'gift-1');
  assert.equal(backCount, 1);
  const editor = makePage(entryDefinition, { ledgerId: 'ledger-b', contextLedgerId: 'ledger-a', editingId: 'gift-1', linkedReceiptId: 'receipt-1', linkedSourceLedgerId: 'ledger-a' });
  await editor.unlinkReturn();
  assert.equal(calls[2].action, 'unlinkReturn');
  assert.equal(calls[2].targetLedgerId, 'ledger-b');
  assert.equal(backCount, 2);
  delete global.wx; cleanup();
});

test('明细页解码中文姓名后查询，避免把百分号编码当姓名', async () => {
  let submitted;
  global.wx = { cloud: { callFunction: async ({ data }) => {
    submitted = data;
    return { result: { entries: [{ id: 'entry-a', personName: '测试', direction: 'received', amountFen: 100, balanceFen: 100, happenedOn: '' }], balanceFen: 100, totalCount: 1, nextOffset: 1, hasMore: false } };
  } } };
  const page = makePage(personDefinition, { ledgerId: '', personName: '' });
  page.onLoad({ ledgerId: 'ledger-a', personName: '%E6%B5%8B%E8%AF%95', filterMode: 'all', filterDate: '2026-10-10' });
  assert.equal(page.data.personName, '测试');
  await page.refreshEntries();
  assert.equal(submitted.personName, '测试');
  assert.equal(page.data.totalCount, 1);
  page.onLoad({ ledgerId: 'ledger-a', personName: '张三', filterMode: 'all' });
  assert.equal(page.data.personName, '张三');
  delete global.wx;
});

test('共享成员退出只清除当前选择并返回账本页', async () => {
  const cleanup = mockSelectedLedger();
  let submitted;
  let removed;
  let switched;
  global.wx = {
    showModal: ({ success }) => success({ confirm: true }),
    cloud: { callFunction: async ({ data }) => { submitted = data; return { result: { left: true } }; } },
    removeStorageSync: key => { removed = key; }, showToast: () => {}, switchTab: ({ url }) => { switched = url; }
  };
  const page = makePage(mineDefinition, { ledgerShared: true });
  await page.leaveLedger();
  assert.deepEqual(submitted, { action: 'leave', ledgerId: 'ledger-a' });
  assert.match(removed, /giftLedger:selected:openid-a/);
  assert.equal(switched, '/pages/index/index');
  delete global.wx; cleanup();
});

test('CSV 先预览再按 20 笔一批导入', async () => {
  const csv = `日期,收送,往来对象,金额（元）,备注\n${Array.from({ length: 23 }, (_, index) => `,收礼,导入${index},10.00,`).join('\n')}`;
  const batches = [];
  global.wx = {
    chooseMessageFile: ({ success }) => success({ tempFiles: [{ path: 'wxfile://test.csv', name: 'test.csv', size: 300 }] }),
    getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: csv }) }),
    cloud: { callFunction: async ({ data }) => { batches.push(data); return { result: { imported: data.rows.length, skipped: 0 } }; } },
    showToast: () => {}
  };
  const page = makePage(mineDefinition);
  await page.chooseImportFile();
  assert.equal(page.data.importRowCount, 23);
  assert.equal(batches.length, 0);
  await page.confirmImport();
  assert.deepEqual(batches.map(item => item.rows.length), [20, 3]);
  assert.ok(batches.every(item => /^[0-9a-f]{32}$/.test(item.importId)));
  assert.match(page.data.importProgress, /完成/);
  delete global.wx;
});

test('CSV 第二批中断后继续导入，沿用原批次编号避免重复', async () => {
  const csv = `日期,收送,往来对象,金额（元）\n${Array.from({ length: 21 }, (_, index) => `,收礼,测试${index},1`).join('\n')}`;
  const batches = [];
  let failOnce = true;
  global.wx = {
    chooseMessageFile: ({ success }) => success({ tempFiles: [{ path: 'wxfile://test.csv', name: 'test.csv', size: 300 }] }),
    getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: csv }) }),
    cloud: { callFunction: async ({ data }) => {
      batches.push({ importId: data.importId, startIndex: data.startIndex });
      if (data.startIndex === 20 && failOnce) { failOnce = false; throw new Error('暂时断网'); }
      return { result: { imported: data.rows.length, skipped: 0 } };
    } }, showToast: () => {}
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const page = makePage(mineDefinition);
    await page.chooseImportFile();
    await page.confirmImport();
    assert.match(page.data.importError, /已确认 20 笔/);
    await page.confirmImport();
    assert.deepEqual(batches.map(item => item.startIndex), [0, 20, 20]);
    assert.equal(new Set(batches.map(item => item.importId)).size, 1);
    assert.match(page.data.importProgress, /完成/);
  } finally { console.error = originalError; delete global.wx; }
});

test('导出会读取所有分页后在手机本地生成 CSV', async () => {
  const calls = [];
  let written;
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://user' },
    cloud: { callFunction: async ({ data }) => {
      calls.push(data.offset);
      if (data.offset === 0) return { result: {
        ledgerName: '婚礼', entries: [{ id: 'a', direction: 'received', personName: '张先生', amountFen: 50000, happenedOn: '2026-10-10', note: '' }],
        nextOffset: 1, hasMore: true
      } };
      return { result: {
        ledgerName: '婚礼', entries: [{ id: 'b', direction: 'given', personName: '李女士', amountFen: 20000, happenedOn: '2026-10-09', note: '' }],
        nextOffset: 2, hasMore: false
      } };
    } },
    getFileSystemManager: () => ({ writeFile: options => { written = options; options.success(); } })
  };
  const page = makePage(mineDefinition);
  await page.prepareExport();
  assert.deepEqual(calls, [0, 1]);
  assert.ok(written.data.includes('500.00'));
  assert.ok(written.data.includes('200.00'));
  assert.equal(page.data.exportFilePath, 'wxfile://user/gift-ledger-export.csv');
  assert.match(page.data.exportFileName, /^礼簿-婚礼-/);
  delete global.wx;
});

test('导出遇到重复记录时不生成文件', async () => {
  let writes = 0;
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://user' },
    cloud: { callFunction: async ({ data }) => ({ result: {
      ledgerName: '婚礼', entries: [{ id: 'a', direction: 'received', personName: '张先生', amountFen: 100, happenedOn: '2026-10-10', note: '' }],
      nextOffset: data.offset + 1, hasMore: data.offset === 0
    } }) },
    getFileSystemManager: () => ({ writeFile: () => { writes += 1; } })
  };
  const page = makePage(mineDefinition);
  const originalError = console.error;
  console.error = () => {};
  try { await page.prepareExport(); } finally { console.error = originalError; }
  assert.equal(writes, 0);
  assert.equal(page.data.exportFilePath, '');
  assert.match(page.data.exportError, /记录发生变化/);
  delete global.wx;
});

test('清除本地导出文件后不能继续发送', () => {
  let removedPath = '';
  global.wx = { getFileSystemManager: () => ({ unlink: ({ filePath, success }) => { removedPath = filePath; success(); } }) };
  const page = makePage(mineDefinition, { exportFilePath: 'wxfile://user/gift-ledger-export.csv', exportFileName: '礼簿-婚礼.csv' });
  page.clearExportFile();
  assert.equal(removedPath, 'wxfile://user/gift-ledger-export.csv');
  assert.equal(page.data.exportFilePath, '');
  assert.match(page.data.exportProgress, /已清除/);
  delete global.wx;
});

test('我的页面保存昵称并更新当前显示', async () => {
  const app = { globalData: { openid: 'user-a', nickname: '' } };
  global.getApp = () => app;
  let submitted;
  global.wx = {
    cloud: { callFunction: async request => { submitted = request; return { result: { openid: 'user-a', nickname: '小余' } }; } },
    showToast: () => {}
  };
  const page = makePage(mineDefinition, { nicknameDraft: ' 小余 ' });
  await page.saveNickname();
  assert.deepEqual(submitted.data, { action: 'updateNickname', nickname: '小余' });
  assert.equal(page.data.nickname, '小余');
  assert.equal(app.globalData.nickname, '小余');
  delete global.wx;
  delete global.getApp;
});

test('我的页面拦截空昵称', async () => {
  let calls = 0;
  global.wx = { cloud: { callFunction: async () => { calls += 1; } } };
  const page = makePage(mineDefinition, { nicknameDraft: '   ' });
  await page.saveNickname();
  assert.match(page.data.nicknameError, /昵称/);
  assert.equal(calls, 0);
  delete global.wx;
});

test('我的页面改名后更新当前账本缓存', async () => {
  const cleanup = mockSelectedLedger();
  let submitted;
  let stored;
  global.wx = {
    cloud: { callFunction: async request => { submitted = request.data; return { result: { ledgerId: 'ledger-a', name: '新婚礼' } }; } },
    setStorageSync: (key, value) => { stored = value; },
    showToast: () => {}
  };
  const page = makePage(mineDefinition, { ledgerNameDraft: ' 新婚礼 ' });
  await page.renameLedger();
  assert.deepEqual(submitted, { action: 'rename', ledgerId: 'ledger-a', name: '新婚礼' });
  assert.equal(page.data.ledgerName, '新婚礼');
  assert.equal(stored.name, '新婚礼');
  delete global.wx; cleanup();
});

test('删除账本需完整输入确认文字，成功后清除当前选择', async () => {
  const cleanup = mockSelectedLedger();
  let calls = 0;
  let removedKey = '';
  let switched = '';
  global.wx = {
    cloud: { callFunction: async ({ data }) => { calls += 1; return { result: { ledgerId: data.ledgerId, deleted: true } }; } },
    removeStorageSync: key => { removedKey = key; },
    showToast: () => {}, switchTab: ({ url }) => { switched = url; }
  };
  const page = makePage(mineDefinition, { deleteDialogOpen: true, deleteConfirmText: '删除账本' });
  await page.deleteLedger();
  assert.equal(calls, 0);
  page.setData({ deleteConfirmText: '确认删除账本' });
  await page.deleteLedger();
  assert.equal(calls, 1);
  assert.equal(page.data.ledgerId, '');
  assert.match(removedKey, /giftLedger:selected:openid-a/);
  assert.equal(switched, '/pages/index/index');
  delete global.wx; cleanup();
});
