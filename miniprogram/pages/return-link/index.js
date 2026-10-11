const { ensureLogin } = require('../../utils/session');
const { getCurrentLedger } = require('../../utils/currentLedger');

function decode(value) {
  try { return decodeURIComponent(value || ''); } catch (_) { return value || ''; }
}

Page({
  data: {
    ledgerId: '', contextLedgerId: '', receivedEntryId: '', personName: '',
    candidates: [], nextOffset: 0, hasMore: true, loading: false, linking: false, error: ''
  },

  onLoad(options) {
    this.setData({ ledgerId: decode(options.ledgerId), contextLedgerId: decode(options.contextLedgerId), receivedEntryId: decode(options.receivedEntryId), personName: decode(options.personName) });
  },

  async onShow() {
    try {
      await ensureLogin();
      const selected = getCurrentLedger();
      if (!selected || selected.id !== this.data.contextLedgerId) throw new Error('账本已切换');
      await this.refreshCandidates();
    } catch (error) {
      console.error('加载送礼候选失败', error);
      this.setData({ error: '无法加载送礼记录，请返回后重试。' });
    }
  },

  onReachBottom() { this.loadMore(); },
  onPullDownRefresh() { this.refreshCandidates().finally(() => wx.stopPullDownRefresh()); },

  async refreshCandidates() {
    this.setData({ candidates: [], nextOffset: 0, hasMore: true, loading: false, error: '' });
    await this.loadMore();
  },

  async loadMore() {
    if (!this.data.ledgerId || !this.data.receivedEntryId || this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true, error: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'entries', data: {
        action: 'returnCandidates', ledgerId: this.data.ledgerId,
        receivedEntryId: this.data.receivedEntryId, offset: this.data.nextOffset
      } });
      const result = response.result;
      if (!result || !Array.isArray(result.candidates)) throw new Error('候选记录格式不正确');
      this.setData({
        candidates: this.data.candidates.concat(result.candidates.map(item => ({
          ...item, amountYuan: (item.amountFen / 100).toFixed(2), dateLabel: item.happenedOn || '未知时间'
        }))),
        nextOffset: result.nextOffset, hasMore: result.hasMore
      });
    } catch (error) {
      console.error('加载送礼候选失败', error);
      this.setData({ error: '送礼记录加载失败，请下拉刷新。' });
    } finally { this.setData({ loading: false }); }
  },

  async chooseCandidate(event) {
    const candidate = this.data.candidates.find(item => item.id === event.currentTarget.dataset.id);
    if (!candidate || this.data.linking) return;
    const confirmed = await new Promise(resolve => wx.showModal({
      title: '确认关联这笔送礼？',
      content: `${candidate.ledgerName} · ${candidate.dateLabel} · ¥${candidate.amountYuan}。不会新增记录或更改金额。`,
      success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false)
    }));
    if (!confirmed) return;
    this.setData({ linking: true, error: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'entries', data: {
        action: 'linkExistingReturn', ledgerId: this.data.ledgerId,
        receivedEntryId: this.data.receivedEntryId,
        targetLedgerId: candidate.ledgerId, returnEntryId: candidate.id
      } });
      if (!response.result || !response.result.linked) throw new Error('关联未保存');
      wx.showToast({ title: '回礼已关联', icon: 'success' });
      wx.navigateBack();
    } catch (error) {
      console.error('关联已有送礼失败', error);
      this.setData({ error: '关联失败，请重试。' });
    } finally { this.setData({ linking: false }); }
  }
});
