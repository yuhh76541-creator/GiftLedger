const cloud = require('wx-server-sdk');
const crypto = require('node:crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const collection = db.collection('ledgers');
const members = db.collection('ledgerMembers');
const invites = db.collection('ledgerInvites');
const users = db.collection('users');
const PAGE_SIZE = 20;

async function getLedger(ledgerId) {
  if (typeof ledgerId !== 'string' || !ledgerId || ledgerId.length > 100) {
    throw new Error('无效的账本 ID');
  }
  const result = await collection.where({ _id: ledgerId }).limit(1).get();
  const ledger = result.data[0];
  return ledger && !ledger.deletedAt ? ledger : null;
}

async function getOwnedLedger(ledgerId, openid) {
  const ledger = await getLedger(ledgerId);
  if (!ledger || ledger.ownerOpenid !== openid) throw new Error('只有账本所有者可以管理此账本');
  return ledger;
}

function readOffset(value) {
  const offset = Number(value || 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new Error('无效的分页位置');
  }
  return offset;
}

function readName(value) {
  if (typeof value !== 'string') throw new Error('请输入账本名称');
  const name = value.trim();
  if (!name || Array.from(name).length > 30 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('账本名称需为 1–30 个字符，不能包含换行');
  }
  return name;
}

async function visiblePage(query, offset, accept) {
  const page = [];
  let cursor = offset;
  while (cursor <= 10000) {
    const result = await query().skip(cursor).limit(PAGE_SIZE + 1).get();
    if (!result.data.length) break;
    for (const item of result.data) {
      cursor += 1;
      const visible = await accept(item);
      if (visible) page.push(visible);
      if (page.length > PAGE_SIZE) return { page: page.slice(0, PAGE_SIZE), nextOffset: cursor - 1, hasMore: true };
    }
    if (result.data.length < PAGE_SIZE + 1) break;
  }
  return { page, nextOffset: cursor, hasMore: false };
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new Error('未取得微信身份');

  if (event.action === 'create') {
    const name = readName(event.name);

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

  if (event.action === 'rename') {
    const ledger = await getOwnedLedger(event.ledgerId, OPENID);
    const name = readName(event.name);
    await collection.doc(ledger._id).update({ data: { name, updatedAt: db.serverDate() } });
    return { ledgerId: ledger._id, name };
  }

  if (event.action === 'delete') {
    const ledger = await getOwnedLedger(event.ledgerId, OPENID);
    if (event.confirmText !== '确认删除账本') throw new Error('请输入“确认删除账本”');
    await collection.doc(ledger._id).update({ data: { deletedAt: db.serverDate(), updatedAt: db.serverDate() } });
    return { ledgerId: ledger._id, deleted: true };
  }

  if (event.action === 'list') {
    const offset = readOffset(event.offset);
    const result = await visiblePage(
      () => collection.where({ ownerOpenid: OPENID }).orderBy('createdAt', 'desc').orderBy('_id', 'desc'),
      offset,
      ledger => ledger.deletedAt ? null : { id: ledger._id, name: ledger.name }
    );
    return {
      ledgers: result.page,
      nextOffset: result.nextOffset,
      hasMore: result.hasMore
    };
  }

  if (event.action === 'createInvite') {
    const ledger = await getOwnedLedger(event.ledgerId, OPENID);
    const code = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    await invites.doc(code).set({
      data: {
        ledgerId: ledger._id,
        ownerOpenid: OPENID,
        expiresAt,
        createdAt: db.serverDate()
      }
    });
    return { code, expiresAt };
  }

  if (event.action === 'join') {
    const code = typeof event.code === 'string' ? event.code.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{32}$/.test(code)) throw new Error('邀请码格式不正确');
    const inviteResult = await invites.where({ _id: code }).limit(1).get();
    const invite = inviteResult.data[0];
    if (!invite || invite.revoked || !Number.isFinite(invite.expiresAt) || invite.expiresAt < Date.now()) {
      throw new Error('邀请码无效或已过期');
    }
    const ledger = await getLedger(invite.ledgerId);
    if (!ledger || ledger.ownerOpenid !== invite.ownerOpenid) throw new Error('账本不存在');
    if (ledger.ownerOpenid === OPENID) return { ledgerId: ledger._id, alreadyJoined: true };
    const memberId = `${ledger._id}_${OPENID}`;
    const existing = await members.where({ _id: memberId }).limit(1).get();
    if (existing.data[0] && existing.data[0].status === 'removed') {
      throw new Error('你已被移出该账本，请联系账本所有者');
    }
    const userResult = await users.where({ _id: OPENID }).limit(1).get();
    const nickname = userResult.data[0] && userResult.data[0].nickname;
    if (typeof nickname !== 'string' || !nickname.trim()) throw new Error('请先设置昵称再加入共享账本');
    if (existing.data[0] && existing.data[0].status === 'left') {
      await members.doc(memberId).update({ data: { status: 'active', joinedAt: db.serverDate(), updatedAt: db.serverDate() } });
    } else if (!existing.data.length) {
      await members.doc(memberId).set({
        data: {
          ledgerId: ledger._id,
          memberOpenid: OPENID,
          role: 'editor',
          joinedAt: db.serverDate()
        }
      });
    }
    return { ledgerId: ledger._id, alreadyJoined: Boolean(existing.data.length) };
  }

  if (event.action === 'leave') {
    const ledger = await getLedger(event.ledgerId);
    if (!ledger || ledger.ownerOpenid === OPENID) throw new Error('只有共享成员可以退出该账本');
    const memberId = `${ledger._id}_${OPENID}`;
    const existing = await members.where({ _id: memberId }).limit(1).get();
    if (!existing.data[0] || existing.data[0].status === 'removed' || existing.data[0].status === 'left') {
      throw new Error('你已不在该共享账本中');
    }
    await members.doc(memberId).update({ data: { status: 'left', updatedAt: db.serverDate() } });
    return { left: true, ledgerId: ledger._id };
  }

  if (event.action === 'listShared') {
    const offset = readOffset(event.offset);
    const result = await visiblePage(
      () => members.where({ memberOpenid: OPENID }).orderBy('joinedAt', 'desc').orderBy('_id', 'desc'),
      offset,
      async member => {
        if (member.status === 'removed' || member.status === 'left') return null;
        const ledger = await getLedger(member.ledgerId);
        return ledger ? { id: ledger._id, name: ledger.name, ownerOpenid: ledger.ownerOpenid } : null;
      }
    );
    const accessible = result.page;
    const ownerOpenids = [...new Set(accessible.map(ledger => ledger.ownerOpenid))];
    const ownerResult = ownerOpenids.length
      ? await users.where({ _id: db.command.in(ownerOpenids) }).limit(ownerOpenids.length).get()
      : { data: [] };
    const ownerNicknames = new Map(ownerResult.data.map(user => [user._id, user.nickname]));
    return {
      ledgers: accessible.map(ledger => {
        const rawNickname = ownerNicknames.get(ledger.ownerOpenid);
        const nickname = typeof rawNickname === 'string' ? rawNickname.trim() : '';
        return {
          id: ledger.id,
          name: ledger.name,
          shared: true,
          ownerLabel: `${nickname || '账本主人'}（尾号 ${ledger.ownerOpenid.slice(-6)}）`
        };
      }),
      nextOffset: result.nextOffset,
      hasMore: result.hasMore
    };
  }

  if (event.action === 'listMembers') {
    const ledger = await getOwnedLedger(event.ledgerId, OPENID);
    const offset = readOffset(event.offset);
    const result = await members.where({ ledgerId: ledger._id })
      .orderBy('joinedAt', 'desc')
      .orderBy('_id', 'desc')
      .skip(offset)
      .limit(PAGE_SIZE + 1)
      .get();
    const page = result.data.slice(0, PAGE_SIZE);
    const openids = [...new Set(page.map(member => member.memberOpenid))];
    const userResult = openids.length
      ? await users.where({ _id: db.command.in(openids) }).limit(openids.length).get()
      : { data: [] };
    const nicknames = new Map(userResult.data.map(user => [user._id, user.nickname]));
    return {
      members: page.map(member => {
        const rawNickname = nicknames.get(member.memberOpenid);
        const nickname = typeof rawNickname === 'string' ? rawNickname.trim() : '';
        return {
          id: member._id,
          label: `${nickname || '成员'}（尾号 ${member.memberOpenid.slice(-6)}）`,
          removed: member.status === 'removed',
          left: member.status === 'left'
        };
      }),
      nextOffset: offset + page.length,
      hasMore: result.data.length > PAGE_SIZE
    };
  }

  if (event.action === 'removeMember' || event.action === 'restoreMember') {
    const ledger = await getOwnedLedger(event.ledgerId, OPENID);
    if (typeof event.memberId !== 'string' || !event.memberId || event.memberId.length > 200) {
      throw new Error('无效的成员 ID');
    }
    const result = await members.where({ _id: event.memberId, ledgerId: ledger._id }).limit(1).get();
    const member = result.data[0];
    if (!member || member.memberOpenid === OPENID) throw new Error('成员不存在');
    if (member.status === 'left') throw new Error('成员已主动退出，请让对方重新使用邀请码加入');
    await members.doc(member._id).update({
      data: { status: event.action === 'removeMember' ? 'removed' : 'active', updatedAt: db.serverDate() }
    });
    return { updated: true };
  }

  if (event.action === 'listInvites') {
    const ledger = await getOwnedLedger(event.ledgerId, OPENID);
    const offset = readOffset(event.offset);
    const result = await invites.where({ ledgerId: ledger._id })
      .orderBy('expiresAt', 'desc')
      .orderBy('_id', 'desc')
      .skip(offset)
      .limit(PAGE_SIZE + 1)
      .get();
    const page = result.data.slice(0, PAGE_SIZE);
    return {
      invites: page.filter(invite => !invite.revoked && invite.expiresAt > Date.now())
        .map(invite => ({ code: invite._id, expiresAt: invite.expiresAt })),
      nextOffset: offset + page.length,
      hasMore: result.data.length > PAGE_SIZE
    };
  }

  if (event.action === 'revokeInvite') {
    const ledger = await getOwnedLedger(event.ledgerId, OPENID);
    if (typeof event.code !== 'string' || !/^[0-9a-f]{32}$/.test(event.code)) {
      throw new Error('无效的邀请码');
    }
    const result = await invites.where({ _id: event.code, ledgerId: ledger._id }).limit(1).get();
    if (!result.data[0]) throw new Error('邀请码不存在');
    await invites.doc(event.code).update({ data: { revoked: true, revokedAt: db.serverDate() } });
    return { revoked: true };
  }

  throw new Error('未知账本操作');
};
