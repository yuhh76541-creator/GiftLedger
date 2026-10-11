const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let openid = 'owner-a';
const ledgers = [{ _id: 'ledger-a', name: '婚礼', ownerOpenid: 'owner-a' }];
const members = [];
const invites = [];
const users = [{ _id: 'owner-b', nickname: '阿明' }, { _id: 'owner-a', nickname: '小余' }];

function collection(items) {
  return {
    where(query) {
      let selected = items.filter(item => Object.entries(query).every(([key, value]) =>
        value && Array.isArray(value.__in) ? value.__in.includes(item[key]) : item[key] === value));
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
          const index = items.findIndex(item => item._id === id);
          if (index >= 0) items.splice(index, 1);
          items.push({ _id: id, ...data });
        },
        async update({ data }) {
          const item = items.find(entry => entry._id === id);
          if (!item) throw new Error('not found');
          Object.assign(item, data);
        }
      };
    },
    async add({ data }) {
      const _id = `ledger-${items.length + 1}`;
      items.push({ _id, ...data });
      return { _id };
    }
  };
}

const fakeDb = {
  command: { in: values => ({ __in: values }) },
  serverDate: () => new Date(),
  collection(name) {
    if (name === 'ledgers') return collection(ledgers);
    if (name === 'ledgerMembers') return collection(members);
    if (name === 'ledgerInvites') return collection(invites);
    if (name === 'users') return collection(users);
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
const handler = require('../cloudfunctions/ledgers/index');
Module._load = originalLoad;

test('只有所有者可以生成 24 小时有效的邀请码', async () => {
  openid = 'owner-b';
  await assert.rejects(handler.main({ action: 'createInvite', ledgerId: 'ledger-a' }), /只有账本所有者/);
  openid = 'owner-a';
  const result = await handler.main({ action: 'createInvite', ledgerId: 'ledger-a' });
  assert.match(result.code, /^[0-9a-f]{32}$/);
  assert.ok(result.expiresAt > Date.now());
  assert.equal(invites[0].ledgerId, 'ledger-a');
});

test('成员凭邀请码加入一次，并能看到共享账本', async () => {
  openid = 'owner-b';
  const code = invites[0]._id;
  const first = await handler.main({ action: 'join', code: code.toUpperCase() });
  const second = await handler.main({ action: 'join', code });
  assert.equal(first.ledgerId, 'ledger-a');
  assert.equal(first.alreadyJoined, false);
  assert.equal(second.alreadyJoined, true);
  assert.equal(members.length, 1);
  const shared = await handler.main({ action: 'listShared' });
  assert.deepEqual(shared.ledgers, [{ id: 'ledger-a', name: '婚礼', shared: true, ownerLabel: '小余（尾号 wner-a）' }]);
  users[1].nickname = '';
  const unnamedOwner = await handler.main({ action: 'listShared' });
  assert.equal(unnamedOwner.ledgers[0].ownerLabel, '账本主人（尾号 wner-a）');
  users[1].nickname = '小余';
});

test('没有昵称的用户不能凭邀请码加入，设置昵称后可加入', async () => {
  openid = 'owner-c';
  const code = invites[0]._id;
  const before = members.length;
  await assert.rejects(handler.main({ action: 'join', code }), /先设置昵称/);
  assert.equal(members.length, before);
  users.push({ _id: 'owner-c', nickname: '小陈' });
  const result = await handler.main({ action: 'join', code });
  assert.equal(result.alreadyJoined, false);
  assert.equal(members.length, before + 1);
  members.splice(before, 1);
});

test('过期或无效邀请码不能加入', async () => {
  openid = 'owner-c';
  await assert.rejects(handler.main({ action: 'join', code: 'bad' }), /格式/);
  invites[0].expiresAt = Date.now() - 1;
  await assert.rejects(handler.main({ action: 'join', code: invites[0]._id }), /过期/);
  assert.equal(members.length, 1);
});

test('所有者可以移除和恢复成员，移除后旧邀请码不能让成员自行重入', async () => {
  openid = 'owner-b';
  await assert.rejects(handler.main({ action: 'listMembers', ledgerId: 'ledger-a' }), /只有账本所有者/);
  await assert.rejects(handler.main({ action: 'removeMember', ledgerId: 'ledger-a', memberId: members[0]._id }), /只有账本所有者/);
  openid = 'owner-a';
  const listed = await handler.main({ action: 'listMembers', ledgerId: 'ledger-a' });
  assert.equal(listed.members.length, 1);
  assert.equal(listed.members[0].removed, false);
  assert.equal(listed.members[0].label, '阿明（尾号 wner-b）');
  users[0].nickname = '阿明新昵称';
  const renamed = await handler.main({ action: 'listMembers', ledgerId: 'ledger-a' });
  assert.equal(renamed.members[0].label, '阿明新昵称（尾号 wner-b）');
  users[0].nickname = '';
  const unnamed = await handler.main({ action: 'listMembers', ledgerId: 'ledger-a' });
  assert.equal(unnamed.members[0].label, '成员（尾号 wner-b）');
  const active = await handler.main({ action: 'createInvite', ledgerId: 'ledger-a' });
  await handler.main({ action: 'removeMember', ledgerId: 'ledger-a', memberId: members[0]._id });
  openid = 'owner-b';
  const shared = await handler.main({ action: 'listShared' });
  assert.deepEqual(shared.ledgers, []);
  await assert.rejects(handler.main({ action: 'join', code: active.code }), /已被移出/);
  openid = 'owner-a';
  await handler.main({ action: 'restoreMember', ledgerId: 'ledger-a', memberId: members[0]._id });
  openid = 'owner-b';
  const restored = await handler.main({ action: 'listShared' });
  assert.equal(restored.ledgers.length, 1);
});

test('撤销邀请码后新用户不能加入', async () => {
  openid = 'owner-a';
  const { code } = await handler.main({ action: 'createInvite', ledgerId: 'ledger-a' });
  const listed = await handler.main({ action: 'listInvites', ledgerId: 'ledger-a' });
  assert.ok(listed.invites.some(invite => invite.code === code));
  await handler.main({ action: 'revokeInvite', ledgerId: 'ledger-a', code });
  openid = 'owner-c';
  await assert.rejects(handler.main({ action: 'join', code }), /无效或已过期/);
});

test('只有创建者可改名，改名同步到共享账本', async () => {
  openid = 'owner-b';
  await assert.rejects(handler.main({ action: 'rename', ledgerId: 'ledger-a', name: '新婚礼' }), /只有账本所有者/);
  openid = 'owner-a';
  await assert.rejects(handler.main({ action: 'rename', ledgerId: 'ledger-a', name: '  ' }), /账本名称/);
  const result = await handler.main({ action: 'rename', ledgerId: 'ledger-a', name: ' 新婚礼 ' });
  assert.equal(result.name, '新婚礼');
  assert.equal((await handler.main({ action: 'list' })).ledgers[0].name, '新婚礼');
  openid = 'owner-b';
  assert.equal((await handler.main({ action: 'listShared' })).ledgers[0].name, '新婚礼');
});

test('共享成员可主动退出并凭新邀请码重入，主人不能代替退出', async () => {
  openid = 'owner-a';
  await assert.rejects(handler.main({ action: 'leave', ledgerId: 'ledger-a' }), /只有共享成员/);
  const invite = await handler.main({ action: 'createInvite', ledgerId: 'ledger-a' });
  openid = 'owner-b';
  const left = await handler.main({ action: 'leave', ledgerId: 'ledger-a' });
  assert.equal(left.left, true);
  assert.deepEqual((await handler.main({ action: 'listShared' })).ledgers, []);
  await assert.rejects(handler.main({ action: 'leave', ledgerId: 'ledger-a' }), /已不在/);
  users[0].nickname = '阿明';
  const rejoined = await handler.main({ action: 'join', code: invite.code });
  assert.equal(rejoined.ledgerId, 'ledger-a');
  assert.equal((await handler.main({ action: 'listShared' })).ledgers.length, 1);
});

test('删除必须输入完整确认文字，删除后所有访问入口失效但数据保留', async () => {
  openid = 'owner-b';
  await assert.rejects(handler.main({ action: 'delete', ledgerId: 'ledger-a', confirmText: '确认删除账本' }), /只有账本所有者/);
  openid = 'owner-a';
  await assert.rejects(handler.main({ action: 'delete', ledgerId: 'ledger-a', confirmText: '删除账本' }), /确认删除账本/);
  assert.equal(ledgers[0].deletedAt, undefined);
  const result = await handler.main({ action: 'delete', ledgerId: 'ledger-a', confirmText: '确认删除账本' });
  assert.equal(result.deleted, true);
  assert.ok(ledgers[0].deletedAt instanceof Date);
  assert.deepEqual((await handler.main({ action: 'list' })).ledgers, []);
  await assert.rejects(handler.main({ action: 'rename', ledgerId: 'ledger-a', name: '再改名' }), /只有账本所有者/);
  openid = 'owner-b';
  assert.deepEqual((await handler.main({ action: 'listShared' })).ledgers, []);
  const code = invites.find(invite => !invite.revoked && invite.expiresAt > Date.now())._id;
  await assert.rejects(handler.main({ action: 'join', code }), /账本不存在/);
});
