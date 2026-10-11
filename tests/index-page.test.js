const test = require('node:test');
const assert = require('node:assert/strict');

let definition;
global.Page = value => { definition = value; };
require('../miniprogram/pages/index/index');
delete global.Page;

function makePage() {
  return {
    ...definition,
    data: { ...definition.data, joinCode: 'a'.repeat(32) },
    setData(patch) { Object.assign(this.data, patch); }
  };
}

async function failedJoin(message) {
  global.getApp = () => ({ globalData: { nickname: '测试用户' } });
  global.wx = { cloud: { callFunction: async () => { throw new Error(message); } } };
  const page = makePage();
  const originalError = console.error;
  console.error = () => {};
  try { await page.joinLedger(); } finally { console.error = originalError; delete global.wx; delete global.getApp; }
  return page.data.listError;
}

test('被移除成员加入时提示账本主人恢复，而非误报邀请码过期', async () => {
  const message = await failedJoin('cloud.callFunction:fail Error: 你已被移出该账本，请联系账本所有者');
  assert.match(message, /账本成员.*恢复/);
  assert.doesNotMatch(message, /过期/);
});

test('真正过期的邀请码显示对应提示', async () => {
  const message = await failedJoin('邀请码无效或已过期');
  assert.match(message, /已过期/);
});

test('未知错误不误报邀请码过期', async () => {
  const message = await failedJoin('网络连接失败');
  assert.match(message, /检查网络/);
  assert.doesNotMatch(message, /过期/);
});

test('未设置昵称时保留邀请码并引导到我的页面，不调用加入接口', async () => {
  let called = false;
  let modal;
  global.getApp = () => ({ globalData: { nickname: '' } });
  global.wx = {
    cloud: { callFunction: async () => { called = true; } },
    showModal(options) { modal = options; },
    switchTab({ url }) { assert.equal(url, '/pages/mine/index'); }
  };
  try {
    const page = makePage();
    await page.joinLedger();
    assert.equal(called, false);
    assert.equal(page.data.joinCode, 'a'.repeat(32));
    modal.success({ confirm: true });
  } finally { delete global.wx; delete global.getApp; }
});
