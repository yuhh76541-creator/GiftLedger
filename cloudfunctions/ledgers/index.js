const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const collection = db.collection('ledgers');
const PAGE_SIZE = 20;

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new Error('未取得微信身份');

  if (event.action === 'create') {
    if (typeof event.name !== 'string') throw new Error('请输入账本名称');
    const name = event.name.trim();
    if (!name || Array.from(name).length > 30) {
      throw new Error('账本名称需为 1–30 个字符');
    }

    const created = await collection.add({
      data: {
        name,
        ownerOpenid: OPENID,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        schemaVersion: 1
      }
    });
    return { ledgerId: created._id };
  }

  if (event.action === 'list') {
    const offset = Number(event.offset || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
      throw new Error('无效的分页位置');
    }
    const result = await collection
      .where({ ownerOpenid: OPENID })
      .orderBy('createdAt', 'desc')
      .orderBy('_id', 'desc')
      .skip(offset)
      .limit(PAGE_SIZE + 1)
      .get();

    const page = result.data.slice(0, PAGE_SIZE).map(({ _id, name }) => ({
      id: _id,
      name
    }));
    return {
      ledgers: page,
      nextOffset: offset + page.length,
      hasMore: result.data.length > PAGE_SIZE
    };
  }

  throw new Error('未知账本操作');
};
