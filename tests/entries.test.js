const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let openid = 'owner-a';
const savedEntries = [];
const fakeLedgers = [{ _id: 'ledger-a', ownerOpenid: 'owner-a', name: '婚礼' }];
const fakeDb = {
  serverDate: () => new Date(),
  collection(name) {
    if (name === 'ledgers') {
      return {
        where(query) {
          return {
            limit() {
              return {
                async get() {
                  return { data: fakeLedgers.filter(item => item._id === query._id) };
                }
              };
            }
          };
        }
      };
    }
    if (name === 'entries') {
      return {
        async add({ data }) {
          savedEntries.push(data);
          return { _id: `entry-${savedEntries.length}` };
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
  assert.equal(savedEntries.length, before);
});

test('无效金额和不存在的日期会被拒绝', async () => {
  openid = 'owner-a';
  const before = savedEntries.length;
  await assert.rejects(entries.main({ ...validEntry, amount: '12.345' }), /金额/);
  await assert.rejects(entries.main({ ...validEntry, happenedOn: '2026-02-30' }), /日期/);
  assert.equal(savedEntries.length, before);
});
