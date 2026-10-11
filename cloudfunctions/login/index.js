const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const users = db.collection('users');

async function findUser(openid) {
  const result = await users.where({ _id: openid }).limit(1).get();
  return result.data[0] || null;
}

exports.main = async (event = {}) => {
  // 身份来自微信云函数上下文，不能接受前端传入的 OpenID。
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    throw new Error('未取得微信 OpenID，请从小程序端调用此云函数');
  }
  if (event.action && event.action !== 'updateNickname') {
    throw new Error('未知用户操作');
  }

  let user = await findUser(OPENID);
  let isNew = false;
  if (!user) {
    try {
      await users.add({
        data: {
          _id: OPENID,
          openid: OPENID,
          createdAt: db.serverDate()
        }
      });
      isNew = true;
    } catch (error) {
      // 并发首次登录时，另一请求可能已用相同 _id 插入。
      // 仅当记录确实已经存在时把本次调用视为成功；其他错误继续抛出。
      user = await findUser(OPENID);
      if (!user) throw error;
    }
  }

  if (event.action === 'updateNickname') {
    if (typeof event.nickname !== 'string') throw new Error('昵称需为 1–20 个字符');
    const nickname = event.nickname.trim();
    if (!nickname || Array.from(nickname).length > 20 || /[\u0000-\u001f\u007f]/.test(nickname)) {
      throw new Error('昵称需为 1–20 个字符，且不能包含换行');
    }
    await users.doc(OPENID).update({ data: { nickname, updatedAt: db.serverDate() } });
    return { openid: OPENID, nickname, isNew };
  }

  return { openid: OPENID, nickname: user && typeof user.nickname === 'string' ? user.nickname : '', isNew };
};
