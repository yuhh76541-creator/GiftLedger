function todayLocal() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

Page({
  data: {
    ledgerId: '',
    ledgerName: '账本',
    direction: 'received',
    personName: '',
    amount: '',
    happenedOn: todayLocal(),
    note: '',
    saving: false,
    listLoading: false,
    error: '',
    entries: [],
    nextOffset: 0,
    hasMore: true
  },

  onLoad(options) {
    if (!options.id) {
      this.setData({ error: '缺少账本 ID，请从首页选择账本。' });
      return;
    }
    this.setData({ ledgerId: options.id });
    this.refreshEntries();
  },

  onReachBottom() {
    this.loadMore();
  },

  onPullDownRefresh() {
    this.refreshEntries().finally(() => wx.stopPullDownRefresh());
  },

  chooseDirection(event) {
    this.setData({ direction: event.currentTarget.dataset.direction });
  },

  onPersonNameInput(event) {
    this.setData({ personName: event.detail.value });
  },

  onAmountInput(event) {
    this.setData({ amount: event.detail.value });
  },

  onDateChange(event) {
    this.setData({ happenedOn: event.detail.value });
  },

  onNoteInput(event) {
    this.setData({ note: event.detail.value });
  },

  async createEntry() {
    const personName = this.data.personName.trim();
    const amount = this.data.amount.trim();
    if (!personName || !amount) {
      wx.showToast({ title: '请填写往来对象和金额', icon: 'none' });
      return;
    }
    if (this.data.saving || this.data.listLoading) return;

    this.setData({ saving: true, error: '' });
    try {
      const response = await wx.cloud.callFunction({
        name: 'entries',
        data: {
          action: 'create',
          ledgerId: this.data.ledgerId,
          direction: this.data.direction,
          personName,
          amount,
          happenedOn: this.data.happenedOn,
          note: this.data.note
        }
      });
      if (!response.result || !response.result.entryId) {
        throw new Error('云函数没有返回记录 ID');
      }
      this.setData({ personName: '', amount: '', note: '' });
      await this.refreshEntries();
      wx.showToast({ title: '已记入账本', icon: 'success' });
    } catch (error) {
      console.error('保存礼金记录失败', error);
      this.setData({ error: error.errMsg || error.message || '保存失败，请稍后重试。' });
    } finally {
      this.setData({ saving: false });
    }
  },

  async refreshEntries() {
    if (!this.data.ledgerId || this.data.listLoading) return;
    this.setData({ entries: [], nextOffset: 0, hasMore: true, error: '' });
    await this.loadMore();
  },

  async loadMore() {
    if (!this.data.ledgerId || this.data.listLoading || !this.data.hasMore) return;
    this.setData({ listLoading: true, error: '' });
    try {
      const response = await wx.cloud.callFunction({
        name: 'entries',
        data: { action: 'list', ledgerId: this.data.ledgerId, offset: this.data.nextOffset }
      });
      const result = response.result;
      if (!result || !Array.isArray(result.entries)) {
        throw new Error('记录列表返回格式不正确');
      }
      const nextEntries = result.entries.map(item => ({
        ...item,
        amountYuan: (item.amountFen / 100).toFixed(2),
        directionLabel: item.direction === 'received' ? '收礼' : '送礼'
      }));
      this.setData({
        ledgerName: result.ledgerName,
        entries: this.data.entries.concat(nextEntries),
        nextOffset: result.nextOffset,
        hasMore: result.hasMore
      });
    } catch (error) {
      console.error('加载礼金记录失败', error);
      this.setData({ error: error.errMsg || error.message || '加载失败，请下拉刷新。' });
    } finally {
      this.setData({ listLoading: false });
    }
  }
});
