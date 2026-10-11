const { ensureLogin } = require('../../utils/session');
const { getCurrentLedger, setCurrentLedger, clearCurrentLedger } = require('../../utils/currentLedger');
const { buildCsv } = require('../../utils/exportCsv');
const { parseCsv } = require('../../utils/importCsv');
const MAX_EXPORT_ROWS = 10000;

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function dateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

Page({
  data: {
    openidSuffix: '', sessionError: '', ledgerId: '', ledgerName: '', ledgerShared: false, ledgerOwnerLabel: '',
    ledgerNameDraft: '', renameBusy: false, deleteBusy: false, deleteDialogOpen: false, deleteConfirmText: '', ledgerManageError: '',
    nickname: '', nicknameDraft: '', nicknameDirty: false, nicknameSaving: false, nicknameError: '',
    inviteCode: '', inviteExpiresAt: '', inviteLoading: false,
    invites: [], inviteNextOffset: 0, inviteHasMore: true, inviteListLoading: false,
    members: [], memberNextOffset: 0, memberHasMore: true, memberLoading: false,
    managementBusy: false, managementError: '',
    exporting: false, exportProgress: '', exportError: '', exportFilePath: '', exportFileName: '',
    leaveBusy: false, importFileName: '', importRowCount: 0, importPreview: [], importProgress: '', importError: '', importing: false, importButtonLabel: ''
  },

  async onShow() {
    try {
      const openid = await ensureLogin();
      const selected = getCurrentLedger();
      const ledgerId = selected ? selected.id : '';
      const changed = this.data.ledgerId !== ledgerId;
      this.setData({
        openidSuffix: openid.slice(-6), sessionError: '',
        nickname: getApp().globalData.nickname || '',
        nicknameDraft: getApp().globalData.nickname || '',
        nicknameDirty: false,
        ledgerId, ledgerName: selected ? selected.name : '', ledgerNameDraft: selected ? selected.name : '',
        ledgerShared: selected ? selected.shared : false,
        ledgerOwnerLabel: selected && selected.shared ? selected.ownerLabel || '' : ''
      });
      if (changed) this.setData({
        inviteCode: '', inviteExpiresAt: '', invites: [], members: [],
        inviteNextOffset: 0, memberNextOffset: 0,
        inviteHasMore: true, memberHasMore: true,
        managementError: '', exportFilePath: '', exportFileName: '', exportProgress: '', exportError: ''
      });
      if (changed) this.setData({ deleteDialogOpen: false, deleteConfirmText: '', ledgerManageError: '' });
      if (changed) {
        this._importRows = null; this._importNextIndex = 0;
        this.setData({ importFileName: '', importRowCount: 0, importPreview: [], importProgress: '', importError: '' });
      }
      if (ledgerId && !selected.shared) {
        if (this.data.memberLoading || this.data.inviteListLoading) this._pendingManagement = true;
        else await this.refreshManagement();
      }
    } catch (error) {
      console.error('连接微信失败', error);
      this.setData({ sessionError: '连接微信失败，请回到账本页重试。' });
    }
  },

  onPullDownRefresh() {
    const tasks = [this.refreshProfile()];
    if (this.data.ledgerId && !this.data.ledgerShared) tasks.push(this.refreshManagement());
    Promise.all(tasks).finally(() => wx.stopPullDownRefresh());
  },
  chooseLedger() { wx.switchTab({ url: '/pages/index/index' }); },

  onLedgerNameDraftInput(event) { this.setData({ ledgerNameDraft: event.detail.value, ledgerManageError: '' }); },
  onDeleteConfirmInput(event) { this.setData({ deleteConfirmText: event.detail.value, ledgerManageError: '' }); },
  openDeleteDialog() {
    if (!this.data.ledgerId || this.data.ledgerShared || this.data.deleteBusy) return;
    this.setData({ deleteDialogOpen: true, deleteConfirmText: '', ledgerManageError: '' });
  },
  closeDeleteDialog() {
    if (!this.data.deleteBusy) this.setData({ deleteDialogOpen: false, deleteConfirmText: '', ledgerManageError: '' });
  },

  async renameLedger() {
    if (!this.data.ledgerId || this.data.ledgerShared || this.data.renameBusy || this.data.deleteBusy) return;
    const name = this.data.ledgerNameDraft.trim();
    if (!name || Array.from(name).length > 30 || /[\u0000-\u001f\u007f]/.test(name)) {
      this.setData({ ledgerManageError: '请输入 1–30 个字的账本名称，不要包含换行。' }); return;
    }
    if (name === this.data.ledgerName) return;
    const ledgerId = this.data.ledgerId;
    this.setData({ renameBusy: true, ledgerManageError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: 'rename', ledgerId, name } });
      if (!response.result || response.result.ledgerId !== ledgerId || response.result.name !== name) throw new Error('云函数未确认改名');
      if (this.data.ledgerId !== ledgerId) return;
      setCurrentLedger({ id: ledgerId, name, shared: false });
      this.setData({ ledgerName: name, ledgerNameDraft: name });
      wx.showToast({ title: '账本已改名', icon: 'success' });
    } catch (error) {
      console.error('修改账本名称失败', error);
      if (this.data.ledgerId === ledgerId) this.setData({ ledgerManageError: '改名失败，请确认 ledgers 云函数已重新部署。' });
    } finally { this.setData({ renameBusy: false }); }
  },

  async deleteLedger() {
    if (!this.data.deleteDialogOpen || !this.data.ledgerId || this.data.ledgerShared || this.data.deleteBusy) return;
    if (this.data.deleteConfirmText !== '确认删除账本') {
      this.setData({ ledgerManageError: '请完整输入“确认删除账本”。' }); return;
    }
    const ledgerId = this.data.ledgerId;
    this.setData({ deleteBusy: true, ledgerManageError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: 'delete', ledgerId, confirmText: '确认删除账本' } });
      if (!response.result || response.result.ledgerId !== ledgerId || response.result.deleted !== true) throw new Error('云函数未确认删除');
      clearCurrentLedger();
      this.setData({ ledgerId: '', ledgerName: '', ledgerNameDraft: '', ledgerShared: false, deleteDialogOpen: false, deleteConfirmText: '', invites: [], members: [] });
      wx.showToast({ title: '账本已删除', icon: 'success' });
      wx.switchTab({ url: '/pages/index/index' });
    } catch (error) {
      console.error('删除账本失败', error);
      if (this.data.ledgerId === ledgerId) this.setData({ ledgerManageError: '删除失败，请检查网络与 ledgers 云函数部署。' });
    } finally { this.setData({ deleteBusy: false }); }
  },

  async leaveLedger() {
    if (!this.data.ledgerId || !this.data.ledgerShared || this.data.leaveBusy) return;
    const confirmed = await new Promise(resolve => wx.showModal({
      title: '退出共享账本？',
      content: '退出后将无法查看或修改此账本，已添加的记录会保留。以后可凭新邀请码重新加入。',
      confirmText: '确认退出', confirmColor: '#a95d40',
      success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false)
    }));
    if (!confirmed) return;
    const ledgerId = this.data.ledgerId;
    this.setData({ leaveBusy: true, ledgerManageError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: 'leave', ledgerId } });
      if (!response.result || !response.result.left) throw new Error('云函数未确认退出');
      clearCurrentLedger();
      this.setData({ ledgerId: '', ledgerName: '', ledgerShared: false, ledgerOwnerLabel: '' });
      wx.showToast({ title: '已退出账本', icon: 'success' });
      wx.switchTab({ url: '/pages/index/index' });
    } catch (error) {
      console.error('退出共享账本失败', error);
      this.setData({ ledgerManageError: '退出失败，请稍后重试。' });
    } finally { this.setData({ leaveBusy: false }); }
  },

  async chooseImportFile() {
    if (!this.data.ledgerId || this.data.importing) return;
    this.setData({ importError: '', importProgress: '' });
    try {
      const chosen = await new Promise((resolve, reject) => wx.chooseMessageFile({
        count: 1, type: 'file', extension: ['csv'], success: resolve, fail: reject
      }));
      const file = chosen.tempFiles && chosen.tempFiles[0];
      if (!file || !file.path) throw new Error('未选择 CSV 文件');
      if (file.size > 1024 * 1024) throw new Error('CSV 文件不能超过 1 MB');
      const content = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
        filePath: file.path, encoding: 'utf8', success: result => resolve(result.data), fail: reject
      }));
      const rows = parseCsv(content);
      this._importRows = rows;
      this._importNextIndex = 0;
      this._importLedgerId = this.data.ledgerId;
      this._importId = `${Date.now().toString(16).padStart(12, '0')}${Math.random().toString(16).slice(2).padEnd(20, '0').slice(0, 20)}`;
      this.setData({
        importFileName: file.name || '未命名.csv', importRowCount: rows.length,
        importPreview: rows.slice(0, 3).map(item => ({ ...item, dateLabel: item.happenedOn || '未知时间', directionLabel: item.direction === 'received' ? '收礼' : '送礼' })),
        importError: '', importProgress: `已校验 ${rows.length} 笔，确认后开始导入。`, importButtonLabel: `确认导入 ${rows.length} 笔`
      });
    } catch (error) {
      if (/cancel/i.test(error.errMsg || '')) return;
      console.error('读取 CSV 失败', error);
      this._importRows = null;
      this.setData({ importFileName: '', importRowCount: 0, importPreview: [], importError: error.message || '读取 CSV 失败，请重试。' });
    }
  },

  async confirmImport() {
    if (this.data.importing || !this._importRows || this._importLedgerId !== this.data.ledgerId) return;
    this.setData({ importing: true, importError: '' });
    try {
      while (this._importNextIndex < this._importRows.length) {
        if (this.data.ledgerId !== this._importLedgerId) throw new Error('账本已切换，请重新选择 CSV');
        const startIndex = this._importNextIndex;
        const rows = this._importRows.slice(startIndex, startIndex + 20);
        const response = await wx.cloud.callFunction({ name: 'entries', data: {
          action: 'importBatch', ledgerId: this._importLedgerId, importId: this._importId, startIndex, rows
        } });
        if (!response.result || response.result.imported + response.result.skipped !== rows.length) throw new Error('云端未确认导入结果');
        this._importNextIndex += rows.length;
        this.setData({ importProgress: `已导入 ${this._importNextIndex}/${this._importRows.length} 笔…` });
      }
      this.setData({ importProgress: `导入完成，共 ${this._importRows.length} 笔。`, importFileName: '', importRowCount: 0, importPreview: [] });
      this._importRows = null;
      wx.showToast({ title: '导入完成', icon: 'success' });
    } catch (error) {
      console.error('CSV 导入失败', error);
      this.setData({ importButtonLabel: '继续导入', importError: `导入中断，已确认 ${this._importNextIndex} 笔。可点击“继续导入”安全重试；${error.message || '请检查网络与云函数部署。'}` });
    } finally { this.setData({ importing: false }); }
  },

  onNicknameInput(event) { this.setData({ nicknameDraft: event.detail.value, nicknameDirty: event.detail.value.trim() !== this.data.nickname, nicknameError: '' }); },

  async refreshProfile() {
    try {
      const response = await wx.cloud.callFunction({ name: 'login' });
      const result = response.result;
      if (!result || result.openid !== getApp().globalData.openid) throw new Error('微信身份发生变化');
      const nickname = typeof result.nickname === 'string' ? result.nickname : '';
      getApp().globalData.nickname = nickname;
      this.setData({ nickname, nicknameDraft: nickname, nicknameDirty: false, nicknameError: '' });
    } catch (error) {
      console.error('刷新昵称失败', error);
      this.setData({ nicknameError: '昵称刷新失败，请稍后重试。' });
    }
  },

  async saveNickname() {
    if (this.data.nicknameSaving) return;
    const nickname = this.data.nicknameDraft.trim();
    if (!nickname || Array.from(nickname).length > 20 || /[\u0000-\u001f\u007f]/.test(nickname)) {
      this.setData({ nicknameError: '请输入 1–20 个字的昵称，不要包含换行。' });
      return;
    }
    this.setData({ nicknameSaving: true, nicknameError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'login', data: { action: 'updateNickname', nickname } });
      const result = response.result;
      if (!result || result.openid !== getApp().globalData.openid || result.nickname !== nickname) throw new Error('云函数未确认昵称更新');
      getApp().globalData.nickname = nickname;
      this.setData({ nickname, nicknameDraft: nickname, nicknameDirty: false });
      wx.showToast({ title: '昵称已保存', icon: 'success' });
    } catch (error) {
      console.error('保存昵称失败', error);
      this.setData({ nicknameError: '保存失败，请确认 login 云函数已部署。' });
    } finally { this.setData({ nicknameSaving: false }); }
  },

  async createInvite() {
    if (!this.data.ledgerId || this.data.ledgerShared || this.data.inviteLoading) return;
    this.setData({ inviteLoading: true, managementError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: 'createInvite', ledgerId: this.data.ledgerId } });
      const result = response.result;
      if (!result || !result.code) throw new Error('云函数没有返回邀请码');
      this.setData({ inviteCode: result.code, inviteExpiresAt: dateLabel(result.expiresAt) });
      await this.refreshInvites();
    } catch (error) {
      console.error('生成邀请码失败', error);
      this.setData({ managementError: '生成邀请码失败，请重试。' });
    } finally { this.setData({ inviteLoading: false }); }
  },

  copyInvite() { if (this.data.inviteCode) wx.setClipboardData({ data: this.data.inviteCode }); },
  copyListedInvite(event) { if (event.currentTarget.dataset.code) wx.setClipboardData({ data: event.currentTarget.dataset.code }); },

  async refreshManagement() {
    if (!this.data.ledgerId || this.data.ledgerShared) return;
    this.setData({
      members: [], memberNextOffset: 0, memberHasMore: true,
      invites: [], inviteNextOffset: 0, inviteHasMore: true, managementError: ''
    });
    await Promise.all([this.loadMembersMore(), this.loadInvitesMore()]);
  },
  async refreshMembers() {
    this.setData({ members: [], memberNextOffset: 0, memberHasMore: true, managementError: '' });
    await this.loadMembersMore();
  },
  async refreshInvites() {
    this.setData({ invites: [], inviteNextOffset: 0, inviteHasMore: true, managementError: '' });
    await this.loadInvitesMore();
  },

  async loadMembersMore() {
    if (!this.data.ledgerId || this.data.ledgerShared || this.data.memberLoading || !this.data.memberHasMore) return;
    const ledgerId = this.data.ledgerId;
    this.setData({ memberLoading: true });
    try {
      const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: 'listMembers', ledgerId, offset: this.data.memberNextOffset } });
      const result = response.result;
      if (!result || !Array.isArray(result.members)) throw new Error('成员列表格式不正确');
      if (this.data.ledgerId !== ledgerId) return;
      this.setData({ members: this.data.members.concat(result.members), memberNextOffset: result.nextOffset, memberHasMore: result.hasMore });
    } catch (error) {
      console.error('加载共享成员失败', error);
      if (this.data.ledgerId === ledgerId) this.setData({ managementError: '成员列表加载失败，请下拉刷新。' });
    } finally {
      this.setData({ memberLoading: false });
      this.runPendingManagement();
    }
  },

  async loadInvitesMore() {
    if (!this.data.ledgerId || this.data.ledgerShared || this.data.inviteListLoading || !this.data.inviteHasMore) return;
    const ledgerId = this.data.ledgerId;
    this.setData({ inviteListLoading: true });
    try {
      const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: 'listInvites', ledgerId, offset: this.data.inviteNextOffset } });
      const result = response.result;
      if (!result || !Array.isArray(result.invites)) throw new Error('邀请码列表格式不正确');
      if (this.data.ledgerId !== ledgerId) return;
      this.setData({
        invites: this.data.invites.concat(result.invites.map(item => ({ code: item.code, expiresAtLabel: dateLabel(item.expiresAt) }))),
        inviteNextOffset: result.nextOffset, inviteHasMore: result.hasMore
      });
    } catch (error) {
      console.error('加载邀请码失败', error);
      if (this.data.ledgerId === ledgerId) this.setData({ managementError: '邀请码加载失败，请下拉刷新。' });
    } finally {
      this.setData({ inviteListLoading: false });
      this.runPendingManagement();
    }
  },

  runPendingManagement() {
    if (!this._pendingManagement || this.data.memberLoading || this.data.inviteListLoading) return;
    this._pendingManagement = false;
    if (this.data.ledgerId && !this.data.ledgerShared) this.refreshManagement();
  },

  changeMember(event) {
    const memberId = event.currentTarget.dataset.id;
    const member = this.data.members.find(item => item.id === memberId);
    if (!member || member.left || this.data.managementBusy) return;
    const restoring = member.removed;
    wx.showModal({
      title: restoring ? '恢复成员' : '移除成员',
      content: restoring ? `重新允许${member.label}访问此账本？` : `移除${member.label}后，对方将不能查看或修改此账本。`,
      confirmColor: restoring ? '#476b55' : '#b34435',
      success: async result => {
        if (!result.confirm) return;
        this.setData({ managementBusy: true, managementError: '' });
        try {
          const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: restoring ? 'restoreMember' : 'removeMember', ledgerId: this.data.ledgerId, memberId } });
          if (!response.result || !response.result.updated) throw new Error('云函数未确认成员更新');
          await this.refreshMembers();
          wx.showToast({ title: restoring ? '成员已恢复' : '成员已移除', icon: 'success' });
        } catch (error) {
          console.error('更新共享成员失败', error);
          this.setData({ managementError: '更新成员失败，请重试。' });
        } finally { this.setData({ managementBusy: false }); }
      }
    });
  },

  revokeInvite(event) {
    const code = event.currentTarget.dataset.code;
    if (!code || this.data.managementBusy) return;
    wx.showModal({
      title: '撤销邀请码', content: '撤销后，未加入的人不能再使用此码；已加入成员不受影响。', confirmColor: '#b34435',
      success: async result => {
        if (!result.confirm) return;
        this.setData({ managementBusy: true, managementError: '' });
        try {
          const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: 'revokeInvite', ledgerId: this.data.ledgerId, code } });
          if (!response.result || !response.result.revoked) throw new Error('云函数未确认撤销');
          if (this.data.inviteCode === code) this.setData({ inviteCode: '', inviteExpiresAt: '' });
          await this.refreshInvites();
          wx.showToast({ title: '邀请码已撤销', icon: 'success' });
        } catch (error) {
          console.error('撤销邀请码失败', error);
          this.setData({ managementError: '撤销失败，请重试。' });
        } finally { this.setData({ managementBusy: false }); }
      }
    });
  },

  exportLedger() {
    if (this.data.exporting || !this.data.ledgerId) return;
    wx.showModal({
      title: '导出账本',
      content: '文件包含此账本的全部往来记录，导出后是不加密的 CSV。请妥善保管，不要发送给无关人员。',
      confirmText: '继续导出', success: result => { if (result.confirm) this.prepareExport(); }
    });
  },

  async prepareExport() {
    if (this.data.exporting || !this.data.ledgerId) return;
    const ledgerId = this.data.ledgerId;
    this.setData({ exporting: true, exportError: '', exportProgress: '正在读取记录…', exportFilePath: '', exportFileName: '' });
    try {
      const allEntries = [];
      const seenIds = new Set();
      let offset = 0;
      let ledgerName = this.data.ledgerName;
      while (true) {
        const response = await wx.cloud.callFunction({ name: 'entries', data: { action: 'exportPage', ledgerId, offset } });
        const result = response.result;
        if (!result || !Array.isArray(result.entries) || !Number.isInteger(result.nextOffset) ||
          result.nextOffset !== offset + result.entries.length || typeof result.hasMore !== 'boolean') throw new Error('导出分页结果格式不正确');
        if (allEntries.length + result.entries.length > MAX_EXPORT_ROWS) throw new Error('记录超过 10000 笔，暂不支持在手机端导出；未生成不完整文件。');
        result.entries.forEach(item => {
          if (!item.id || seenIds.has(item.id)) throw new Error('导出期间记录发生变化，请稍后重试。');
          seenIds.add(item.id); allEntries.push(item);
        });
        if (this.data.ledgerId !== ledgerId) throw new Error('账本已切换，请重新导出。');
        ledgerName = result.ledgerName || ledgerName;
        this.setData({ exportProgress: `已读取 ${allEntries.length} 笔…` });
        if (!result.hasMore) break;
        if (!result.entries.length || result.nextOffset <= offset) throw new Error('导出分页异常，未生成文件');
        offset = result.nextOffset;
      }
      const filePath = `${wx.env.USER_DATA_PATH}/gift-ledger-export.csv`;
      await new Promise((resolve, reject) => {
        wx.getFileSystemManager().writeFile({ filePath, data: buildCsv(allEntries), encoding: 'utf8', success: resolve, fail: reject });
      });
      const safeName = String(ledgerName).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 30) || '账本';
      this.setData({ exportFilePath: filePath, exportFileName: `礼簿-${safeName}-${todayLocal()}.csv`, exportProgress: `已生成 ${allEntries.length} 笔记录，请点击“发送导出文件”。` });
    } catch (error) {
      console.error('导出账本失败', error);
      this.setData({ exportProgress: '', exportError: error.message || '导出失败，请重试。' });
    } finally { this.setData({ exporting: false }); }
  },

  shareExportFile() {
    if (!this.data.exportFilePath) return;
    if (typeof wx.shareFileMessage !== 'function') {
      this.setData({ exportError: '当前微信版本不支持发送文件，请更新微信后重试。' }); return;
    }
    wx.shareFileMessage({
      filePath: this.data.exportFilePath, fileName: this.data.exportFileName,
      fail: error => { console.error('发送导出文件失败', error); this.setData({ exportError: '发送文件失败或已取消，请重试。' }); }
    });
  },

  clearExportFile() {
    if (!this.data.exportFilePath) return;
    wx.getFileSystemManager().unlink({
      filePath: this.data.exportFilePath,
      success: () => this.setData({ exportFilePath: '', exportFileName: '', exportProgress: '本地导出文件已清除。', exportError: '' }),
      fail: error => { console.error('清除导出文件失败', error); this.setData({ exportError: '清除本地文件失败，请重试。' }); }
    });
  }
});
