Page({
  data: {
    status: '准备连接云开发',
    loginLoading: false,
    openid: '',
    loginError: '',
    newLedgerName: '',
    createLoading: false,
    listLoading: false,
    listError: '',
    ledgers: [],
    nextOffset: 0,
    hasMore: true,
    selectedLedgerId: '',
    selectedLedgerName: ''
  },

  onLoad() {
    this.login();
  },

  onReachBottom() {
    this.loadMore();
  },

  onPullDownRefresh() {
    this.refreshLedgers().finally(() => wx.stopPullDownRefresh());
  },

  async login() {
    const app = getApp();
    if (!wx.cloud || !app.globalData.env) {
      this.setData({
        status: '等待配置',
        loginError: '请先在 miniprogram/app.js 填写云环境 ID，然后重新编译。'
      });
      return;
    }

    this.setData({ loginLoading: true, status: '正在登录…', loginError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'login' });
      const result = response.result;
      if (!result || !result.openid) throw new Error('login 云函数没有返回 OpenID');
      this.setData({ status: '已登录', openid: result.openid });
      await this.refreshLedgers();
    } catch (error) {
      console.error('登录失败', error);
      this.setData({
        status: '登录失败',
        loginError: error.errMsg || error.message || '请查看云函数日志。'
      });
    } finally {
      this.setData({ loginLoading: false });
    }
  },

  onLedgerNameInput(event) {
    this.setData({ newLedgerName: event.detail.value });
  },

  async createLedger() {
    const name = this.data.newLedgerName.trim();
    if (!name || Array.from(name).length > 30) {
      wx.showToast({ title: '请输入 1–30 字的名称', icon: 'none' });
      return;
    }
    if (this.data.createLoading || this.data.listLoading) return;

    this.setData({ createLoading: true, listError: '' });
    try {
      const response = await wx.cloud.callFunction({
        name: 'ledgers',
        data: { action: 'create', name }
      });
      if (!response.result || !response.result.ledgerId) {
        throw new Error('云函数没有返回账本 ID');
      }
      this.setData({ newLedgerName: '' });
      await this.refreshLedgers();
      wx.showToast({ title: '账本已创建', icon: 'success' });
    } catch (error) {
      console.error('创建账本失败', error);
      this.setData({ listError: error.errMsg || error.message || '创建失败，请稍后重试。' });
    } finally {
      this.setData({ createLoading: false });
    }
  },

  async refreshLedgers() {
    if (!this.data.openid || this.data.listLoading) return;
    this.setData({ ledgers: [], nextOffset: 0, hasMore: true, listError: '' });
    await this.loadMore();
  },

  async loadMore() {
    if (!this.data.openid || this.data.listLoading || !this.data.hasMore) return;
    this.setData({ listLoading: true, listError: '' });
    try {
      const response = await wx.cloud.callFunction({
        name: 'ledgers',
        data: { action: 'list', offset: this.data.nextOffset }
      });
      const result = response.result;
      if (!result || !Array.isArray(result.ledgers)) {
        throw new Error('账本列表返回格式不正确');
      }
      const ledgers = this.data.ledgers.concat(result.ledgers);
      const selected = ledgers.find(item => item.id === this.data.selectedLedgerId);
      this.setData({
        ledgers,
        nextOffset: result.nextOffset,
        hasMore: result.hasMore,
        selectedLedgerName: selected ? selected.name : ''
      });
    } catch (error) {
      console.error('加载账本失败', error);
      this.setData({ listError: error.errMsg || error.message || '加载失败，请下拉刷新。' });
    } finally {
      this.setData({ listLoading: false });
    }
  },

  selectLedger(event) {
    const id = event.currentTarget.dataset.id;
    const selected = this.data.ledgers.find(item => item.id === id);
    if (!selected) return;
    this.setData({ selectedLedgerId: id, selectedLedgerName: selected.name });
  },

  openSelectedLedger() {
    if (!this.data.selectedLedgerId) return;
    wx.navigateTo({
      url: `/pages/ledger/index?id=${encodeURIComponent(this.data.selectedLedgerId)}`
    });
  }
});
