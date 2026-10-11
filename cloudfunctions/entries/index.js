const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const ledgers = db.collection('ledgers');
const entries = db.collection('entries');
const PAGE_SIZE = 20;

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

async function getOwnedLedger(ledgerId, openid) {
  if (typeof ledgerId !== 'string' || !ledgerId || ledgerId.length > 100) {
    throw new Error('无效的账本 ID');
  }
  const result = await ledgers.where({ _id: ledgerId }).limit(1).get();
  const ledger = result.data[0];
  if (!ledger || ledger.ownerOpenid !== openid) throw new Error('账本不存在或无权访问');
  return ledger;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new Error('未取得微信身份');
  const ledger = await getOwnedLedger(event.ledgerId, OPENID);

  if (event.action === 'create') {
    const { direction, personName, amount, happenedOn, note = '' } = event;
    if (direction !== 'received' && direction !== 'given') throw new Error('无效的收送方向');
    if (typeof personName !== 'string' || !personName.trim() || Array.from(personName.trim()).length > 40) {
      throw new Error('往来对象需为 1–40 个字符');
    }
    if (!validDate(happenedOn)) throw new Error('请选择有效日期');
    if (typeof note !== 'string' || Array.from(note.trim()).length > 200) {
      throw new Error('备注不能超过 200 个字符');
    }
    const amountFen = parseAmountFen(amount);
    const created = await entries.add({
      data: {
        ledgerId: ledger._id,
        createdByOpenid: OPENID,
        direction,
        personName: personName.trim(),
        amountFen,
        happenedOn,
        note: note.trim(),
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        schemaVersion: 1
      }
    });
    return { entryId: created._id };
  }

  if (event.action === 'list') {
    const offset = Number(event.offset || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
      throw new Error('无效的分页位置');
    }
    const result = await entries
      .where({ ledgerId: ledger._id })
      .orderBy('happenedOn', 'desc')
      .orderBy('_id', 'desc')
      .skip(offset)
      .limit(PAGE_SIZE + 1)
      .get();
    const page = result.data.slice(0, PAGE_SIZE).map(item => ({
      id: item._id,
      direction: item.direction,
      personName: item.personName,
      amountFen: item.amountFen,
      happenedOn: item.happenedOn,
      note: item.note
    }));
    return {
      ledgerName: ledger.name,
      entries: page,
      nextOffset: offset + page.length,
      hasMore: result.data.length > PAGE_SIZE
    };
  }

  throw new Error('未知记账操作');
};
