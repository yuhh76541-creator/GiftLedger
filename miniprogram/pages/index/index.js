const { ensureLogin } = require('../../utils/session');
const { getCurrentLedger, setCurrentLedger } = require('../../utils/currentLedger');

function joinErrorMessage(error) {
  const detail = `${error && error.errMsg || ''} ${error && error.message || ''}`;
  if (/先设置昵称/.test(detail)) return '请先到“我的”设置昵称，再返回加入共享账本。';
  if (/已被移出|已被移除|被移出该账本/.test(detail)) {
    return '你已被移出该账本。请联系账本主人在“我的 → 账本成员”中点击“恢复”，无需再次使用邀请码。';
  }
  if (/邀请码无效|邀请码已过期|无效或已过期|邀请码不存在|撤销/.test(detail)) {
    return '邀请码无效、已撤销或已过期，请让账本主人重新生成。';
  }
  return '加入失败，请检查网络后重试；若仍失败，请查看云函数日志。';
}

Page({
  data: {
    status: '正在连接微信…', loginLoading: false, loginError: '', openid: '',
    newLedgerName: '', createLoading: false, listLoading: false, listError: '',
    ledgers: [], nextOffset: 0, hasMore: true,
    sharedLedgers: [], sharedNextOffset: 0, sharedHasMore: true, sharedLoading: false,
    joinCode: '', joinLoading: false, nicknameReady: false,
    selectedLedgerId: '', selectedLedgerName: '', selectedLedgerShared: false, selectedLedgerOwnerLabel: '',
    summaryLoading: false, summaryError: '',
    summary: { receivedYuan: '0.00', givenYuan: '0.00' }
  },

  onLoad() { this.login(); },

  onHide() { this._refreshOnShow = true; },

  onShow() {
    const selected = getCurrentLedger();
    const changed = this.data.selectedLedgerId !== (selected ? selected.id : '');
    this.setData({
      nicknameReady: Boolean((getApp().globalData.nickname || '').trim()),
      selectedLedgerId: selected ? selected.id : '',
      selectedLedgerName: selected ? selected.name : '',
      selectedLedgerShared: selected ? selected.shared : false,
      selectedLedgerOwnerLabel: selected && selected.shared ? selected.ownerLabel || '' : '',
      ...(changed ? { summary: { receivedYuan: '0.00', givenYuan: '0.00' }, summaryError: '' } : {})
    });
    if (selected) this.loadCurrentSummary(selected.id);
    else this._summaryRequest = (this._summaryRequest || 0) + 1;
    if (this._refreshOnShow && this.data.openid) {
      this._refreshOnShow = false;
      this.refreshLedgers();
    }
  },

  async loadCurrentSummary(ledgerId) {
    const request = this._summaryRequest = (this._summaryRequest || 0) + 1;
    this.setData({ summaryLoading: true, summaryError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'entries', data: { action: 'summary', ledgerId } });
      const result = response.result;
      if (!result || !Number.isFinite(result.receivedFen) || !Number.isFinite(result.givenFen)) throw new Error('统计结果格式不正确');
      if (this.data.selectedLedgerId !== ledgerId || this._summaryRequest !== request) return;
      this.setData({ summary: {
        receivedYuan: (result.receivedFen / 100).toFixed(2),
        givenYuan: (result.givenFen / 100).toFixed(2)
      } });
    } catch (error) {
      console.error('加载当前账本统计失败', error);
      if (this.data.selectedLedgerId === ledgerId && this._summaryRequest === request) this.setData({ summaryError: '概览暂不可用' });
    } finally {
      if (this._summaryRequest === request) this.setData({ summaryLoading: false });
    }
  },

  onReachBottom() { this.loadMore(); },
  onPullDownRefresh() { this.refreshLedgers().finally(() => wx.stopPullDownRefresh()); },

  async login() {
    this.setData({ loginLoading: true, status: '正在登录…', loginError: '' });
    try {
      const openid = await ensureLogin();
      this.setData({ status: '已连接微信', openid });
      this.onShow();
      await this.refreshLedgers();
    } catch (error) {
      console.error('登录失败', error);
      this.setData({ status: '连接失败', loginError: error.message || error.errMsg || '请稍后重试。' });
    } finally { this.setData({ loginLoading: false }); }
  },

  onLedgerNameInput(event) { this.setData({ newLedgerName: event.detail.value }); },
  onJoinCodeInput(event) { this.setData({ joinCode: event.detail.value }); },

  async createLedger() {
    const name = this.data.newLedgerName.trim();
    if (!name || Array.from(name).length > 30) {
      wx.showToast({ title: '请输入 1–30 字的名称', icon: 'none' }); return;
    }
    if (this.data.createLoading || this.data.listLoading) return;
    this.setData({ createLoading: true, listError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: 'create', name } });
      if (!response.result || !response.result.ledgerId) throw new Error('云函数没有返回账本 ID');
      setCurrentLedger({ id: response.result.ledgerId, name, shared: false });
      this.setData({ newLedgerName: '' });
      this.onShow();
      await this.refreshLedgers();
      wx.showToast({ title: '账本已创建', icon: 'success' });
    } catch (error) {
      console.error('创建账本失败', error);
      this.setData({ listError: error.message || error.errMsg || '创建失败，请稍后重试。' });
    } finally { this.setData({ createLoading: false }); }
  },

  async joinLedger() {
    const code = this.data.joinCode.trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(code)) {
      wx.showToast({ title: '请输入完整的 32 位邀请码', icon: 'none' }); return;
    }
    if (!(getApp().globalData.nickname || '').trim()) {
      wx.showModal({
        title: '先设置昵称',
        content: '共享账本会用昵称标识记录添加人。设置并保存昵称后，返回此页即可继续加入，邀请码会保留。',
        confirmText: '去设置',
        success: result => { if (result.confirm) wx.switchTab({ url: '/pages/mine/index' }); }
      });
      return;
    }
    if (this.data.joinLoading) return;
    this.setData({ joinLoading: true, listError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: 'join', code } });
      if (!response.result || !response.result.ledgerId) throw new Error('加入账本失败');
      this.setData({ joinCode: '' });
      await this.refreshLedgers();
      wx.showToast({ title: '已加入账本', icon: 'success' });
    } catch (error) {
      console.error('加入共享账本失败', error);
      this.setData({ listError: joinErrorMessage(error) });
    } finally { this.setData({ joinLoading: false }); }
  },

  async refreshLedgers() {
    if (!this.data.openid || this.data.listLoading || this.data.sharedLoading) return;
    this.setData({
      ledgers: [], nextOffset: 0, hasMore: true,
      sharedLedgers: [], sharedNextOffset: 0, sharedHasMore: true, listError: ''
    });
    await Promise.all([this.loadMore(), this.loadSharedMore()]);
  },

  async loadMore() {
    if (!this.data.openid || this.data.listLoading || !this.data.hasMore) return;
    this.setData({ listLoading: true });
    try {
      const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: 'list', offset: this.data.nextOffset } });
      const result = response.result;
      if (!result || !Array.isArray(result.ledgers)) throw new Error('账本列表格式不正确');
      this.setData({ ledgers: this.data.ledgers.concat(result.ledgers), nextOffset: result.nextOffset, hasMore: result.hasMore });
    } catch (error) {
      console.error('加载账本失败', error);
      this.setData({ listError: '账本加载失败，请下拉刷新。' });
    } finally { this.setData({ listLoading: false }); }
  },

  async loadSharedMore() {
    if (!this.data.openid || this.data.sharedLoading || !this.data.sharedHasMore) return;
    this.setData({ sharedLoading: true });
    try {
      const response = await wx.cloud.callFunction({ name: 'ledgers', data: { action: 'listShared', offset: this.data.sharedNextOffset } });
      const result = response.result;
      if (!result || !Array.isArray(result.ledgers)) throw new Error('共享账本列表格式不正确');
      const selected = result.ledgers.find(item => item.id === this.data.selectedLedgerId);
      if (selected) {
        setCurrentLedger(selected);
        this.setData({ selectedLedgerName: selected.name, selectedLedgerOwnerLabel: selected.ownerLabel || '' });
      }
      this.setData({ sharedLedgers: this.data.sharedLedgers.concat(result.ledgers), sharedNextOffset: result.nextOffset, sharedHasMore: result.hasMore });
    } catch (error) {
      console.error('加载共享账本失败', error);
      this.setData({ listError: '共享账本加载失败，请下拉刷新。' });
    } finally { this.setData({ sharedLoading: false }); }
  },

  selectLedger(event) {
    const selected = this.data.ledgers.concat(this.data.sharedLedgers).find(item => item.id === event.currentTarget.dataset.id);
    if (!selected) return;
    setCurrentLedger(selected);
    this.onShow();
    wx.showToast({ title: '已切换账本', icon: 'success' });
  },

  openSelectedLedger() {
    if (this.data.selectedLedgerId) wx.switchTab({ url: '/pages/ledger/index' });
  }
});
