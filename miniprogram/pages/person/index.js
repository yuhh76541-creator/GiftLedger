const { ensureLogin } = require('../../utils/session');
const { getCurrentLedger } = require('../../utils/currentLedger');

function decodePageParam(value) {
  if (typeof value !== 'string') return '';
  try { return decodeURIComponent(value); } catch (_) { return value; }
}

Page({
  data: {
    ledgerId: '', personName: '', filterMode: 'all', filterDate: '', scopeLabel: '全部时间',
    entries: [], totalCount: 0, archiveScope: false,
    nextOffset: 0, hasMore: true, loading: false, error: ''
  },

  onLoad(options) {
    const ledgerId = decodePageParam(options.ledgerId);
    const personName = decodePageParam(options.personName);
    const filterMode = decodePageParam(options.filterMode);
    const filterDate = decodePageParam(options.filterDate);
    this.setData({
      ledgerId,
      personName,
      filterMode: ['all', 'day', 'month'].includes(filterMode) ? filterMode : 'all',
      filterDate,
      scopeLabel: filterMode === 'day' ? filterDate : filterMode === 'month' ? filterDate.slice(0, 7) : '全部时间'
    });
  },

  async onShow() {
    try {
      await ensureLogin();
      const selected = getCurrentLedger();
      if (!selected || selected.id !== this.data.ledgerId) throw new Error('账本已切换');
      await this.refreshEntries();
    } catch (error) {
      console.error('打开往来明细失败', error);
      this.setData({ error: '无法打开往来明细，请返回往来页重试。' });
    }
  },

  onReachBottom() { this.loadMore(); },
  onPullDownRefresh() { this.refreshEntries().finally(() => wx.stopPullDownRefresh()); },

  async refreshEntries() {
    this._version = (this._version || 0) + 1;
    this.setData({ entries: [], nextOffset: 0, hasMore: true, loading: false, error: '' });
    await this.loadMore(this._version);
  },

  async loadMore(version = this._version) {
    if (!this.data.ledgerId || !this.data.personName || this.data.loading || !this.data.hasMore) return;
    const ledgerId = this.data.ledgerId;
    this.setData({ loading: true, error: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'entries', data: {
        action: 'personPage', ledgerId, personName: this.data.personName,
        filterMode: this.data.filterMode, filterDate: this.data.filterDate, offset: this.data.nextOffset
      } });
      const result = response.result;
      if (!result || !Array.isArray(result.entries)) throw new Error('明细格式不正确');
      if (version !== this._version || ledgerId !== this.data.ledgerId) return;
      const mapped = result.entries.map(item => ({
        ...item, amountYuan: (item.amountFen / 100).toFixed(2),
        dateLabel: item.happenedOn || '未知时间',
        directionLabel: item.direction === 'received' ? '收礼' : item.returnForEntryId ? '回礼' : '送礼',
        latestReturnYuan: item.latestReturn ? (item.latestReturn.amountFen / 100).toFixed(2) : '',
        latestReturnDate: item.latestReturn ? item.latestReturn.happenedOn || '未知时间' : ''
      }));
      this.setData({
        entries: this.data.entries.concat(mapped), nextOffset: result.nextOffset, hasMore: result.hasMore,
        totalCount: result.totalCount, archiveScope: result.archiveScope === true
      });
    } catch (error) {
      console.error('加载往来明细失败', error);
      if (version === this._version) this.setData({ error: '明细加载失败，请下拉刷新重试。' });
    } finally { if (version === this._version) this.setData({ loading: false }); }
  },

  startEdit(event) {
    const entry = this.data.entries.find(item => item.id === event.currentTarget.dataset.id);
    if (!entry) return;
    wx.navigateTo({
      url: `/pages/entry/index?ledgerId=${encodeURIComponent(entry.ledgerId)}&contextLedgerId=${encodeURIComponent(this.data.ledgerId)}&entryId=${encodeURIComponent(entry.id)}`,
      success: result => result.eventChannel.emit('editEntry', entry)
    });
  },

  recordReturn(event) {
    const entry = this.data.entries.find(item => item.id === event.currentTarget.dataset.id);
    if (!entry || entry.direction !== 'received') return;
    wx.navigateTo({ url: `/pages/entry/index?ledgerId=${encodeURIComponent(entry.ledgerId)}&contextLedgerId=${encodeURIComponent(this.data.ledgerId)}&returnForEntryId=${encodeURIComponent(entry.id)}&personName=${encodeURIComponent(entry.personName)}&receivedAmountFen=${entry.amountFen}&receivedDate=${encodeURIComponent(entry.happenedOn || '')}` });
  },

  linkExistingReturn(event) {
    const entry = this.data.entries.find(item => item.id === event.currentTarget.dataset.id);
    if (!entry || entry.direction !== 'received') return;
    wx.navigateTo({ url: `/pages/return-link/index?ledgerId=${encodeURIComponent(entry.ledgerId)}&contextLedgerId=${encodeURIComponent(this.data.ledgerId)}&receivedEntryId=${encodeURIComponent(entry.id)}&personName=${encodeURIComponent(entry.personName)}` });
  },

  async clearLegacySettled(event) {
    const entry = this.data.entries.find(item => item.id === event.currentTarget.dataset.id);
    if (!entry || !entry.settled || entry.returnCount || this.data.loading) return;
    try {
      const response = await wx.cloud.callFunction({ name: 'entries', data: { action: 'setSettled', ledgerId: entry.ledgerId, entryId: entry.id, settled: false } });
      if (!response.result || response.result.settled !== false) throw new Error('旧标记未清除');
      await this.refreshEntries();
    } catch (error) {
      console.error('清除旧结清标记失败', error);
      this.setData({ error: '旧标记清除失败，请重试。' });
    }
  }
});
