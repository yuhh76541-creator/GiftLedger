const cloud = require('wx-server-sdk');
const { match } = require('pinyin-pro');
const crypto = require('node:crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const ledgers = db.collection('ledgers');
const members = db.collection('ledgerMembers');
const entries = db.collection('entries');
const users = db.collection('users');
const PAGE_SIZE = 20;
const EXPORT_PAGE_SIZE = 100;
const SEARCH_BATCH_SIZE = 100;
const MAX_SEARCH_ROWS = 10000;

function parseAmountFen(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value)) {
    throw new Error('金额需为正数，最多两位小数');
  }
  const [yuan, fraction = ''] = value.split('.');
  const amountFen = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
  if (amountFen <= 0) throw new Error('金额需大于 0');
  return amountFen;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function compareEntryTime(a, b) {
  const byDate = (a.happenedOn || '').localeCompare(b.happenedOn || '');
  const aCreated = Number(new Date(a.createdAt)) || 0;
  const bCreated = Number(new Date(b.createdAt)) || 0;
  return byDate || aCreated - bCreated || a._id.localeCompare(b._id);
}

function readNameQuery(event) {
  const nameQuery = event.nameQuery === undefined ? '' : event.nameQuery;
  if (typeof nameQuery !== 'string' || Array.from(nameQuery.trim()).length > 40) throw new Error('姓名搜索最多 40 个字符');
  return nameQuery.trim();
}

function entryFilter(event, ledgerId, includeName = true) {
  const mode = event.filterMode || 'all';
  if (!['all', 'day', 'month'].includes(mode)) throw new Error('无效的日期筛选方式');
  const query = { ledgerId };
  if (mode !== 'all') {
    if (!validDate(event.filterDate)) throw new Error('请选择有效的筛选日期');
    if (mode === 'day') query.happenedOn = event.filterDate;
    else {
      const year = Number(event.filterDate.slice(0, 4));
      const month = Number(event.filterDate.slice(5, 7));
      const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
      query.happenedOn = db.command.gte(`${event.filterDate.slice(0, 7)}-01`).and(db.command.lt(nextMonth));
    }
  }
  const name = readNameQuery(event);
  if (includeName && name) query.personName = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return query;
}

function isPinyinQuery(name) {
  return /^[a-z\s]+$/i.test(name);
}

// Search existing records as well as new ones, without requiring a one-time data migration.
async function scanPinyinEntries(event, ledgerId, accept) {
  const name = readNameQuery(event).replace(/\s+/g, '').toLowerCase();
  const query = entryFilter(event, ledgerId, false);
  await walkEntries(query, item => {
    const personName = typeof item.personName === 'string' ? item.personName : '';
    if (personName.toLowerCase().includes(name) || match(personName, name, { continuous: true })) return accept(item);
  });
}

async function walkEntries(query, accept) {
  for (let rawOffset = 0; rawOffset <= MAX_SEARCH_ROWS; rawOffset += SEARCH_BATCH_SIZE) {
    const result = await entries.where(query)
      .orderBy('happenedOn', 'desc').orderBy('_id', 'desc')
      .skip(rawOffset).limit(SEARCH_BATCH_SIZE).get();
    if (rawOffset === MAX_SEARCH_ROWS) {
      if (result.data.length) throw new Error('单次查询最多支持 10000 笔记录，请缩小日期范围');
      return;
    }
    for (const item of result.data) {
      if (accept(item) === false) return;
    }
    if (result.data.length < SEARCH_BATCH_SIZE) return;
  }
}

async function labelCreators(page) {
  const openids = [...new Set(page.map(item => item.createdByOpenid).filter(Boolean))];
  const result = openids.length
    ? await users.where({ _id: db.command.in(openids) }).limit(openids.length).get()
    : { data: [] };
  const nicknames = new Map(result.data.map(user => [user._id, user.nickname]));
  return page.map(item => {
    const rawNickname = nicknames.get(item.createdByOpenid);
    const nickname = typeof rawNickname === 'string' ? rawNickname.trim() : '';
    return {
      id: item._id,
      direction: item.direction,
      personName: item.personName,
      amountFen: item.amountFen,
      happenedOn: item.happenedOn,
      note: item.note || '',
      settled: item.settled === true,
      returnForEntryId: item.returnForEntryId || '',
      returnForLedgerId: item.returnForLedgerId || '',
      createdByLabel: item.createdByOpenid
        ? `${nickname || '成员'}（尾号 ${item.createdByOpenid.slice(-6)}）`
        : '未知添加人'
    };
  });
}

async function getAccessibleLedger(ledgerId, openid) {
  if (typeof ledgerId !== 'string' || !ledgerId || ledgerId.length > 100) {
    throw new Error('无效的账本 ID');
  }
  const result = await ledgers.where({ _id: ledgerId }).limit(1).get();
  const ledger = result.data[0];
  if (!ledger || ledger.deletedAt) throw new Error('账本不存在或无权访问');
  if (ledger.ownerOpenid !== openid) {
    const memberId = `${ledgerId}_${openid}`;
    const membership = await members.where({ _id: memberId }).limit(1).get();
    if (!membership.data[0] || membership.data[0].role !== 'editor' || ['removed', 'left'].includes(membership.data[0].status)) {
      throw new Error('账本不存在或无权访问');
    }
  }
  return ledger;
}

async function getEntryInLedger(entryId, ledgerId) {
  if (typeof entryId !== 'string' || !entryId || entryId.length > 100) {
    throw new Error('无效的记录 ID');
  }
  const result = await entries.where({ _id: entryId }).limit(1).get();
  const entry = result.data[0];
  if (!entry || entry.ledgerId !== ledgerId) throw new Error('记录不存在或不属于该账本');
  return entry;
}

async function returnLedgerChoices(ledger, openid) {
  if (ledger.ownerOpenid !== openid) return [{ id: ledger._id, name: ledger.name }];
  const result = await ledgers.where({ ownerOpenid: openid }).limit(100).get();
  const active = result.data.filter(item => !item.deletedAt).map(item => ({ id: item._id, name: item.name }));
  if (result.data.length === 100) {
    const next = await ledgers.where({ ownerOpenid: openid }).skip(100).limit(1).get();
    if (next.data.length) throw new Error('账本过多，暂无法列出全部回礼账本');
  }
  return active;
}

async function linkedReturns(receipts, ledger, openid) {
  if (!receipts.length) return [];
  const allowed = new Set((await returnLedgerChoices(ledger, openid)).map(item => item.id));
  const result = [];
  for (let start = 0; start < receipts.length; start += 10) {
    const ids = receipts.slice(start, start + 10).map(item => item._id);
    for (let offset = 0; offset <= MAX_SEARCH_ROWS; offset += SEARCH_BATCH_SIZE) {
      const page = await entries.where({ returnForEntryId: db.command.in(ids) }).skip(offset).limit(SEARCH_BATCH_SIZE).get();
      if (offset === MAX_SEARCH_ROWS && page.data.length) throw new Error('关联回礼过多，请缩小日期范围');
      result.push(...page.data.filter(item => allowed.has(item.ledgerId) && item.returnForLedgerId === ledger._id && item.direction === 'given'));
      if (page.data.length < SEARCH_BATCH_SIZE) break;
    }
  }
  return result;
}

function parseEntryInput(event) {
  const { direction, personName, amount, happenedOn, note = '' } = event;
  if (direction !== 'received' && direction !== 'given') throw new Error('无效的收送方向');
  if (typeof personName !== 'string' || !personName.trim() || Array.from(personName.trim()).length > 40) {
    throw new Error('往来对象需为 1–40 个字符');
  }
  if (happenedOn !== '' && !validDate(happenedOn)) throw new Error('请选择有效日期');
  if (typeof note !== 'string' || Array.from(note.trim()).length > 200) {
    throw new Error('备注不能超过 200 个字符');
  }
  return {
    direction,
    personName: personName.trim(),
    amountFen: parseAmountFen(amount),
    happenedOn,
    note: note.trim()
  };
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new Error('未取得微信身份');
  const ledger = await getAccessibleLedger(event.ledgerId, OPENID);

  if (event.action === 'create') {
    const input = parseEntryInput(event);
    const created = await entries.add({
      data: {
        ledgerId: ledger._id,
        createdByOpenid: OPENID,
        ...input,
        settled: false,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        schemaVersion: 1
      }
    });
    return { entryId: created._id };
  }

  if (event.action === 'update') {
    const existing = await getEntryInLedger(event.entryId, ledger._id);
    const input = parseEntryInput(event);
    if (existing.returnForEntryId && (input.direction !== 'given' || input.personName !== existing.personName)) throw new Error('关联回礼不能更改往来对象或方向');
    if (existing.direction === 'received' && (input.direction !== 'received' || input.personName !== existing.personName)) {
      if ((await linkedReturns([existing], ledger, OPENID)).length) throw new Error('请先删除关联的回礼，再更改收礼对象或方向');
    }
    await entries.doc(event.entryId).update({
      data: { ...input, updatedAt: db.serverDate() }
    });
    return { updated: true };
  }

  if (event.action === 'delete') {
    const existing = await getEntryInLedger(event.entryId, ledger._id);
    if (existing.direction === 'received' && (await linkedReturns([existing], ledger, OPENID)).length) throw new Error('请先删除关联的回礼，再删除这笔收礼');
    await entries.doc(event.entryId).remove();
    return { deleted: true };
  }

  if (event.action === 'setSettled') {
    if (typeof event.settled !== 'boolean') throw new Error('无效的结清状态');
    await getEntryInLedger(event.entryId, ledger._id);
    await entries.doc(event.entryId).update({ data: { settled: event.settled, updatedAt: db.serverDate() } });
    return { updated: true, settled: event.settled };
  }

  if (event.action === 'returnLedgerChoices') {
    return { ledgers: await returnLedgerChoices(ledger, OPENID) };
  }

  if (event.action === 'createReturn') {
    const receipt = await getEntryInLedger(event.receivedEntryId, ledger._id);
    if (receipt.direction !== 'received') throw new Error('只能为收礼记录登记回礼');
    const target = await getAccessibleLedger(event.targetLedgerId, OPENID);
    if (target.ownerOpenid !== ledger.ownerOpenid) throw new Error('回礼账本与收礼账本的主人必须相同');
    if (ledger.ownerOpenid !== OPENID && target._id !== ledger._id) throw new Error('共享成员仅可在当前账本登记回礼');
    const input = parseEntryInput({ ...event, direction: 'given', personName: receipt.personName });
    const created = await entries.add({ data: {
      ledgerId: target._id, createdByOpenid: OPENID, ...input,
      returnForEntryId: receipt._id, returnForLedgerId: ledger._id,
      settled: false, createdAt: db.serverDate(), updatedAt: db.serverDate(), schemaVersion: 1
    } });
    return { entryId: created._id, targetLedgerId: target._id };
  }

  if (event.action === 'returnCandidates') {
    const receipt = await getEntryInLedger(event.receivedEntryId, ledger._id);
    if (receipt.direction !== 'received') throw new Error('只能为收礼记录关联回礼');
    const offset = Number(event.offset || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('无效的分页位置');
    const choices = await returnLedgerChoices(ledger, OPENID);
    const available = [];
    for (const book of choices) {
      await walkEntries({ ledgerId: book.id, personName: receipt.personName }, item => {
        if (item.direction === 'given' && !item.returnForEntryId) available.push({
          id: item._id, _id: item._id, createdAt: item.createdAt,
          ledgerId: book.id, ledgerName: book.name,
          amountFen: item.amountFen, happenedOn: item.happenedOn || '', note: item.note || ''
        });
      });
    }
    available.sort(compareEntryTime).reverse();
    const page = available.slice(offset, offset + PAGE_SIZE).map(({ _id, createdAt, ...item }) => item);
    return { candidates: page, nextOffset: offset + page.length, hasMore: available.length > offset + PAGE_SIZE };
  }

  if (event.action === 'linkExistingReturn' || event.action === 'unlinkReturn') {
    const receipt = await getEntryInLedger(event.receivedEntryId, ledger._id);
    if (receipt.direction !== 'received') throw new Error('原记录必须为收礼');
    const target = await getAccessibleLedger(event.targetLedgerId, OPENID);
    if (target.ownerOpenid !== ledger.ownerOpenid || (ledger.ownerOpenid !== OPENID && target._id !== ledger._id)) throw new Error('无权关联此回礼账本');
    const gift = await getEntryInLedger(event.returnEntryId, target._id);
    if (gift.direction !== 'given' || gift.personName !== receipt.personName) throw new Error('回礼须是同一对象的送礼记录');
    if (event.action === 'linkExistingReturn') {
      if (gift.returnForEntryId) throw new Error('这笔送礼已关联其他收礼');
      await entries.doc(gift._id).update({ data: { returnForEntryId: receipt._id, returnForLedgerId: ledger._id, updatedAt: db.serverDate() } });
      return { linked: true };
    }
    if (gift.returnForEntryId !== receipt._id || gift.returnForLedgerId !== ledger._id) throw new Error('关联关系不存在');
    await entries.doc(gift._id).update({ data: { returnForEntryId: '', returnForLedgerId: '', updatedAt: db.serverDate() } });
    return { unlinked: true };
  }

  if (event.action === 'importBatch') {
    if (typeof event.importId !== 'string' || !/^[0-9a-f]{32}$/.test(event.importId)) throw new Error('无效的导入批次');
    if (!Number.isInteger(event.startIndex) || event.startIndex < 0 || event.startIndex > 10000) throw new Error('无效的导入位置');
    if (!Array.isArray(event.rows) || !event.rows.length || event.rows.length > 20) throw new Error('每批只能导入 1–20 笔');
    const inputRows = event.rows.map(row => {
      if (row.settled !== undefined && typeof row.settled !== 'boolean') throw new Error('无效的结清状态');
      return { ...parseEntryInput(row), settled: row.settled === true };
    });
    let imported = 0;
    let skipped = 0;
    for (let index = 0; index < inputRows.length; index += 1) {
      const hash = crypto.createHash('sha256').update(`${ledger._id}:${OPENID}:${event.importId}:${event.startIndex + index}`).digest('hex').slice(0, 32);
      const entryId = `imp_${hash}`;
      const existing = await entries.where({ _id: entryId }).limit(1).get();
      if (existing.data.length) { skipped += 1; continue; }
      await entries.doc(entryId).set({ data: {
        ledgerId: ledger._id, createdByOpenid: OPENID, ...inputRows[index],
        createdAt: db.serverDate(), updatedAt: db.serverDate(), schemaVersion: 1
      } });
      imported += 1;
    }
    return { imported, skipped };
  }

  if (event.action === 'groupList') {
    const offset = Number(event.offset || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('无效的分页位置');
    const groups = new Map();
    const collect = item => {
      const key = item.personName;
      if (!groups.has(key)) groups.set(key, { personName: key, count: 0, latestEntry: item, receipts: [] });
      const group = groups.get(key);
      group.count += 1;
      if (item.direction === 'received') group.receipts.push(item);
      if (compareEntryTime(item, group.latestEntry) > 0) group.latestEntry = item;
    };
    if (isPinyinQuery(readNameQuery(event))) await scanPinyinEntries(event, ledger._id, collect);
    else await walkEntries(entryFilter(event, ledger._id), collect);
    const ordered = [...groups.values()].sort((a, b) => compareEntryTime(b.latestEntry, a.latestEntry) || a.personName.localeCompare(b.personName, 'zh-CN'));
    const pageGroups = ordered.slice(offset, offset + PAGE_SIZE);
    const receipts = pageGroups.flatMap(group => group.receipts);
    const returns = await linkedReturns(receipts, ledger, OPENID);
    const byReceipt = new Map();
    returns.forEach(item => { const rows = byReceipt.get(item.returnForEntryId) || []; rows.push(item); byReceipt.set(item.returnForEntryId, rows); });
    const page = pageGroups.map(group => {
      const visibleReceipts = group.receipts;
      const related = visibleReceipts.flatMap(item => byReceipt.get(item._id) || []);
      const newestReceipt = visibleReceipts.sort(compareEntryTime).at(-1);
      const newestReturn = related.sort(compareEntryTime).at(-1);
      return {
        personName: group.personName, count: group.count,
        receivedCount: visibleReceipts.length,
        pendingCount: visibleReceipts.filter(item => !(byReceipt.get(item._id) || []).length && item.settled !== true).length,
        unpricedCount: visibleReceipts.filter(item => !(byReceipt.get(item._id) || []).length && item.settled === true).length,
        latestReceived: newestReceipt ? { amountFen: newestReceipt.amountFen, happenedOn: newestReceipt.happenedOn || '' } : null,
        latestReturn: newestReturn ? { amountFen: newestReturn.amountFen, happenedOn: newestReturn.happenedOn || '' } : null,
        latest: {
        direction: group.latestEntry.direction,
        amountFen: group.latestEntry.amountFen,
        happenedOn: group.latestEntry.happenedOn || '',
        returnForEntryId: group.latestEntry.returnForEntryId || '',
        settled: group.latestEntry.settled === true
        }
      };
    });
    return { ledgerName: ledger.name, groups: page, nextOffset: offset + page.length, hasMore: ordered.length > offset + PAGE_SIZE, totalGroups: ordered.length };
  }

  if (event.action === 'personPage') {
    const personName = event.personName;
    if (typeof personName !== 'string' || !personName.trim() || Array.from(personName).length > 40) throw new Error('无效的往来对象');
    const offset = Number(event.offset || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('无效的分页位置');
    const all = [];
    const archive = !event.filterMode || event.filterMode === 'all';
    const choices = archive ? await returnLedgerChoices(ledger, OPENID) : [{ id: ledger._id, name: ledger.name }];
    for (const book of choices) {
      const query = book.id === ledger._id ? entryFilter(event, book.id, false) : { ledgerId: book.id };
      await walkEntries({ ...query, personName }, item => { all.push(item); });
    }
    all.sort(compareEntryTime);
    all.reverse();
    const returns = [];
    for (const book of choices) {
      const bookReceipts = all.filter(item => item.ledgerId === book.id && item.direction === 'received');
      returns.push(...await linkedReturns(bookReceipts, { _id: book.id, name: book.name, ownerOpenid: ledger.ownerOpenid }, OPENID));
    }
    const returnIds = new Set(returns.map(item => item._id));
    const combined = all.filter(item => !returnIds.has(item._id)).concat(returns);
    combined.sort(compareEntryTime).reverse();
    const page = await labelCreators(combined.slice(offset, offset + PAGE_SIZE));
    const names = new Map(choices.map(item => [item.id, item.name]));
    const returnRows = new Map();
    returns.forEach(item => { const rows = returnRows.get(item.returnForEntryId) || []; rows.push(item); returnRows.set(item.returnForEntryId, rows); });
    page.forEach(item => {
      const raw = combined.find(row => row._id === item.id);
      item.ledgerName = raw.ledgerId === ledger._id ? ledger.name : names.get(raw.ledgerId) || '';
      item.ledgerId = raw.ledgerId;
      item.returnForEntryId = raw.returnForEntryId || '';
      const linked = returnRows.get(raw._id) || [];
      item.returnCount = linked.length;
      const newest = linked.sort(compareEntryTime).at(-1);
      item.latestReturn = newest ? { amountFen: newest.amountFen, happenedOn: newest.happenedOn || '' } : null;
      item.returned = item.direction === 'received' && (item.returnCount > 0 || item.settled);
    });
    return { personName, entries: page, totalCount: combined.length, nextOffset: offset + page.length, hasMore: combined.length > offset + PAGE_SIZE, archiveScope: archive && choices.length > 1 };
  }

  if (event.action === 'summary') {
    if (isPinyinQuery(readNameQuery(event))) {
      const summary = { receivedFen: 0, givenFen: 0, receivedCount: 0, givenCount: 0 };
      await scanPinyinEntries(event, ledger._id, item => {
        if (item.direction === 'received') {
          summary.receivedFen += item.amountFen;
          summary.receivedCount += 1;
        } else if (item.direction === 'given') {
          summary.givenFen += item.amountFen;
          summary.givenCount += 1;
        }
      });
      return summary;
    }
    const $ = db.command.aggregate;
    const result = await entries
      .aggregate()
      .match(entryFilter(event, ledger._id))
      .group({
        _id: '$direction',
        totalFen: $.sum('$amountFen'),
        count: $.sum(1)
      })
      .end();
    const summary = {
      receivedFen: 0,
      givenFen: 0,
      receivedCount: 0,
      givenCount: 0
    };
    if (!Array.isArray(result.list)) {
      throw new Error('统计查询返回格式不正确');
    }
    result.list.forEach(item => {
      if (item._id === 'received') {
        summary.receivedFen = item.totalFen;
        summary.receivedCount = item.count;
      } else if (item._id === 'given') {
        summary.givenFen = item.totalFen;
        summary.givenCount = item.count;
      }
    });
    return summary;
  }

  if (event.action === 'exportPage') {
    const offset = Number(event.offset || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
      throw new Error('无效的导出分页位置');
    }
    const result = await entries
      .where({ ledgerId: ledger._id })
      .orderBy('happenedOn', 'desc')
      .orderBy('_id', 'desc')
      .skip(offset)
      .limit(EXPORT_PAGE_SIZE + 1)
      .get();
    const rawPage = result.data.slice(0, EXPORT_PAGE_SIZE);
    const returns = await linkedReturns(rawPage.filter(item => item.direction === 'received'), ledger, OPENID);
    const returnedReceiptIds = new Set(returns.map(item => item.returnForEntryId));
    const page = rawPage.map(item => ({
      id: item._id,
      direction: item.direction,
      personName: item.personName,
      amountFen: item.amountFen,
      happenedOn: item.happenedOn,
      note: item.note || '',
      settled: item.settled === true,
      returned: item.direction === 'received' && returnedReceiptIds.has(item._id),
      returnForEntryId: item.returnForEntryId || ''
    }));
    return {
      ledgerName: ledger.name,
      entries: page,
      nextOffset: offset + page.length,
      hasMore: result.data.length > EXPORT_PAGE_SIZE
    };
  }

  if (event.action === 'list') {
    const offset = Number(event.offset || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
      throw new Error('无效的分页位置');
    }
    let rawPage;
    let hasMore;
    if (isPinyinQuery(readNameQuery(event))) {
      const matches = [];
      let skipped = 0;
      await scanPinyinEntries(event, ledger._id, item => {
        if (skipped < offset) { skipped += 1; return; }
        matches.push(item);
        return matches.length <= PAGE_SIZE;
      });
      rawPage = matches.slice(0, PAGE_SIZE);
      hasMore = matches.length > PAGE_SIZE;
    } else {
      const result = await entries
        .where(entryFilter(event, ledger._id))
        .orderBy('happenedOn', 'desc')
        .orderBy('_id', 'desc')
        .skip(offset)
        .limit(PAGE_SIZE + 1)
        .get();
      rawPage = result.data.slice(0, PAGE_SIZE);
      hasMore = result.data.length > PAGE_SIZE;
    }
    const page = await labelCreators(rawPage);
    return {
      ledgerName: ledger.name,
      entries: page,
      nextOffset: offset + page.length,
      hasMore
    };
  }

  throw new Error('未知记账操作');
};
