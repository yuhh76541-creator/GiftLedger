const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let openid = 'user-a';
const users = [];
const fakeDb = {
  serverDate: () => new Date(),
  collection(name) {
    assert.equal(name, 'users');
    return {
      where(query) {
        return { limit() { return this; }, async get() { return { data: users.filter(user => user._id === query._id) }; } };
      },
      async add({ data }) { users.push({ ...data }); },
      doc(id) {
        return { async update({ data }) {
          const user = users.find(item => item._id === id);
          if (!user) throw new Error('user not found');
          Object.assign(user, data);
        } };
      }
    };
  }
};
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => fakeDb,
  getWXContext: () => ({ OPENID: openid })
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud;
  return originalLoad.call(this, request, parent, isMain);
};
const handler = require('../cloudfunctions/login/index');
Module._load = originalLoad;

test('首次登录创建用户，之后登录保留昵称', async () => {
  const first = await handler.main();
  assert.equal(first.openid, 'user-a');
  assert.equal(first.nickname, '');
  assert.equal(first.isNew, true);
  assert.equal(users.length, 1);
  const renamed = await handler.main({ action: 'updateNickname', nickname: '  小余  ', openid: 'user-b' });
  assert.equal(renamed.nickname, '小余');
  assert.equal(users[0].nickname, '小余');
  const again = await handler.main();
  assert.equal(again.nickname, '小余');
  assert.equal(again.isNew, false);
  assert.equal(users.length, 1);
});

test('昵称只修改当前微信用户，其他用户互不影响', async () => {
  openid = 'user-b';
  const second = await handler.main({ action: 'updateNickname', nickname: '阿明', openid: 'user-a' });
  assert.equal(second.openid, 'user-b');
  assert.equal(second.nickname, '阿明');
  assert.equal(users.find(item => item._id === 'user-a').nickname, '小余');
});

test('拒绝空昵称、超长昵称和换行', async () => {
  await assert.rejects(handler.main({ action: 'updateNickname', nickname: '   ' }), /昵称/);
  await assert.rejects(handler.main({ action: 'updateNickname', nickname: '字'.repeat(21) }), /昵称/);
  await assert.rejects(handler.main({ action: 'updateNickname', nickname: '名字\n下一行' }), /昵称/);
  assert.equal(users.find(item => item._id === 'user-b').nickname, '阿明');
});
