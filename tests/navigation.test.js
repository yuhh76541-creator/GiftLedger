const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getCurrentLedger, setCurrentLedger, clearCurrentLedger } = require('../miniprogram/utils/currentLedger');

test('底栏包含账本、往来、我的三个页面', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.deepEqual(config.tabBar.list.map(item => item.text), ['账本', '往来', '我的']);
  for (const item of config.tabBar.list) {
    assert.ok(config.pages.includes(item.pagePath));
    for (const icon of [item.iconPath, item.selectedIconPath]) {
      const bytes = fs.readFileSync(path.join(__dirname, '../miniprogram', icon));
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(bytes.readUInt32BE(16), 81);
      assert.equal(bytes.readUInt32BE(20), 81);
      assert.ok(bytes.length < 40 * 1024);
    }
  }
});

test('正式小程序不包含云开发媒体上传示例页', () => {
  const root = path.join(__dirname, '../miniprogram');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.ok(config.pages.every(page => !page.startsWith('pages/example/')));
  assert.equal(fs.existsSync(path.join(root, 'pages/example/index.js')), false);
  for (const page of ['index', 'ledger', 'mine', 'entry', 'person']) {
    const source = fs.readFileSync(path.join(root, `pages/${page}/index.js`), 'utf8');
    assert.doesNotMatch(source, /wx\.(?:chooseMedia|chooseImage)\s*\(/);
  }
});

test('各页面的交互按钮都有对应处理函数', () => {
  for (const name of ['index', 'ledger', 'mine', 'entry', 'person']) {
    let definition;
    global.Page = value => { definition = value; };
    const modulePath = require.resolve(`../miniprogram/pages/${name}/index.js`);
    delete require.cache[modulePath];
    require(modulePath);
    delete global.Page;
    const source = fs.readFileSync(path.join(__dirname, `../miniprogram/pages/${name}/index.wxml`), 'utf8');
    for (const match of source.matchAll(/\b(?:bindtap|bindinput|bindchange)="([^"]+)"/g)) {
      assert.equal(typeof definition[match[1]], 'function', `${name} 缺少 ${match[1]}`);
    }
  }
});

test('当前账本按微信身份分别记住', () => {
  const storage = new Map();
  const app = { globalData: { openid: 'user-a' } };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key)
  };
  setCurrentLedger({ id: 'ledger-a', name: '婚礼', shared: false });
  app.globalData.openid = 'user-b';
  assert.equal(getCurrentLedger(), null);
  setCurrentLedger({ id: 'ledger-b', name: '日常', shared: true, ownerLabel: '小余（尾号 wner-a）' });
  assert.deepEqual(getCurrentLedger(), { id: 'ledger-b', name: '日常', shared: true, ownerLabel: '小余（尾号 wner-a）' });
  app.globalData.openid = 'user-a';
  assert.deepEqual(getCurrentLedger(), { id: 'ledger-a', name: '婚礼', shared: false, ownerLabel: '' });
  clearCurrentLedger();
  assert.equal(getCurrentLedger(), null);
  app.globalData.openid = 'user-b';
  assert.equal(getCurrentLedger().id, 'ledger-b');
  delete global.getApp;
  delete global.wx;
});
