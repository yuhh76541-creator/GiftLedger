const { ensureLogin } = require('../../utils/session');
const { getCurrentLedger, setCurrentLedger } = require('../../utils/currentLedger');

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const emptySummary = { receivedYuan: '0.00', givenYuan: '0.00', receivedCount: 0, givenCount: 0 };

Page({
  data: {
    ledgerId: '', ledgerName: '', ledgerOwnerLabel: '', sessionError: '',
    entries: [], nextOffset: 0, hasMore: true, listLoading: false, listError: '', totalCount: 0, groupCount: 0,
    filterMode: 'all', filterDate: todayLocal(), filterDateLabel: todayLocal(), searchDraft: '', searchName: '',
    summaryLoading: false, summaryError: '',
    summary: emptySummary
  },

  async onShow() {
    try {
      await ensureLogin();
      const selected = getCurrentLedger();
      if (!selected) {
        this._queryVersion = (this._queryVersion || 0) + 1;
        this.setData({ ledgerId: '', ledgerName: '', ledgerOwnerLabel: '', entries: [], totalCount: 0, sessionError: '' });
        return;
      }
      this.setData({
        ledgerId: selected.id, ledgerName: selected.name,
        ledgerOwnerLabel: selected.shared ? selected.ownerLabel || '' : '', sessionError: '',
        ...(this.data.ledgerId !== selected.id ? { totalCount: 0 } : {})
      });
      await this.refreshEntries();
    } catch (error) {
      console.error('连接微信失败', error);
      this.setData({ sessionError: '连接微信失败，请返回账本页重试。' });
    }
  },

  onReachBottom() { this.loadMore(); },
  onPullDownRefresh() { this.refreshEntries().finally(() => wx.stopPullDownRefresh()); },
  chooseLedger() { wx.switchTab({ url: '/pages/index/index' }); },

  chooseFilterMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (!['all', 'day', 'month'].includes(mode) || mode === this.data.filterMode) return;
    this.setData({ filterMode: mode, filterDateLabel: mode === 'month' ? this.data.filterDate.slice(0, 7) : this.data.filterDate });
    return this.refreshEntries();
  },
  onFilterDateChange(event) {
    const value = event.detail.value;
    const date = this.data.filterMode === 'month' && /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    this.setData({ filterDate: date, filterDateLabel: this.data.filterMode === 'month' ? date.slice(0, 7) : date });
    return this.refreshEntries();
  },
  onSearchInput(event) { this.setData({ searchDraft: event.detail.value }); },
  applySearch() {
    const name = this.data.searchDraft.trim();
    if (Array.from(name).length > 40) { this.setData({ listError: '姓名搜索最多 40 个字符。' }); return; }
    if (name === this.data.searchName) return;
    this.setData({ searchName: name });
    return this.refreshEntries();
  },
  clearSearch() {
    if (!this.data.searchDraft && !this.data.searchName) return;
    this.setData({ searchDraft: '', searchName: '' });
    return this.refreshEntries();
  },

  currentFilter() {
    return { filterMode: this.data.filterMode, filterDate: this.data.filterDate, nameQuery: this.data.searchName };
  },

  addEntry() {
    if (!this.data.ledgerId) return;
    wx.navigateTo({ url: `/pages/entry/index?ledgerId=${encodeURIComponent(this.data.ledgerId)}` });
  },

  openPerson(event) {
    const personName = event.currentTarget.dataset.name;
    if (!this.data.entries.some(item => item.personName === personName)) return;
    wx.navigateTo({ url: `/pages/person/index?ledgerId=${encodeURIComponent(this.data.ledgerId)}&personName=${encodeURIComponent(personName)}&filterMode=${encodeURIComponent(this.data.filterMode)}&filterDate=${encodeURIComponent(this.data.filterDate)}` });
  },

  async refreshEntries() {
    if (!this.data.ledgerId) return;
    const version = (this._queryVersion || 0) + 1;
    this._queryVersion = version;
    this.setData({ entries: [], nextOffset: 0, hasMore: true, listLoading: false, listError: '', summaryLoading: false, summaryError: '', totalCount: 0, groupCount: 0, summary: emptySummary });
    await Promise.all([this.loadMore(version), this.loadSummary(version)]);
  },

  async loadSummary(version = this._queryVersion) {
    if (!this.data.ledgerId || this.data.summaryLoading) return;
    const ledgerId = this.data.ledgerId;
    const filter = this.currentFilter();
    this.setData({ summaryLoading: true, summaryError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'entries', data: { action: 'summary', ledgerId, ...filter } });
      const result = response.result;
      if (!result || !Number.isFinite(result.receivedFen) || !Number.isFinite(result.givenFen)) throw new Error('统计结果格式不正确');
      if (this.data.ledgerId !== ledgerId || version !== this._queryVersion) return;
      this.setData({ summary: {
        receivedYuan: (result.receivedFen / 100).toFixed(2),
        givenYuan: (result.givenFen / 100).toFixed(2),
        receivedCount: result.receivedCount, givenCount: result.givenCount
      }, totalCount: result.receivedCount + result.givenCount });
    } catch (error) {
      console.error('加载账本统计失败', error);
      if (this.data.ledgerId === ledgerId && version === this._queryVersion) this.setData({ summaryError: '统计暂不可用，请下拉刷新重试。' });
    } finally {
      if (version === this._queryVersion) this.setData({ summaryLoading: false });
    }
  },

  async loadMore(version = this._queryVersion) {
    if (!this.data.ledgerId || this.data.listLoading || !this.data.hasMore) return;
    const ledgerId = this.data.ledgerId;
    const filter = this.currentFilter();
    this.setData({ listLoading: true, listError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'entries', data: { action: 'groupList', ledgerId, offset: this.data.nextOffset, ...filter } });
      const result = response.result;
      if (!result || !Array.isArray(result.groups)) throw new Error('往来归类格式不正确');
      if (this.data.ledgerId !== ledgerId || version !== this._queryVersion) return;
      const entries = result.groups.map(item => ({
        ...item,
        latestAmountYuan: (item.latest.amountFen / 100).toFixed(2),
        latestDirectionLabel: item.latest.direction === 'received' ? '收礼' : item.latest.returnForEntryId ? '回礼' : '送礼',
        latestOnLabel: item.latest.happenedOn || '未知时间',
        receivedAmountYuan: item.latestReceived ? (item.latestReceived.amountFen / 100).toFixed(2) : '',
        receivedOnLabel: item.latestReceived ? item.latestReceived.happenedOn || '未知时间' : '',
        returnAmountYuan: item.latestReturn ? (item.latestReturn.amountFen / 100).toFixed(2) : '',
        returnOnLabel: item.latestReturn ? item.latestReturn.happenedOn || '未知时间' : ''
      }));
      if (result.ledgerName && result.ledgerName !== this.data.ledgerName) {
        const selected = getCurrentLedger();
        if (selected && selected.id === ledgerId) setCurrentLedger({ ...selected, name: result.ledgerName });
      }
      this.setData({ ledgerName: result.ledgerName || this.data.ledgerName, entries: this.data.entries.concat(entries), nextOffset: result.nextOffset, hasMore: result.hasMore, groupCount: result.totalGroups });
    } catch (error) {
      console.error('加载礼金记录失败', error);
      if (this.data.ledgerId === ledgerId && version === this._queryVersion) this.setData({ listError: '记录加载失败，请下拉刷新重试。' });
    } finally {
      if (version === this._queryVersion) this.setData({ listLoading: false });
    }
  }
});
