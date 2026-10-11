const { getCurrentLedger } = require('../../utils/currentLedger');

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/;

Page({
  data: {
    ledgerId: '', ledgerName: '', contextLedgerId: '', editingId: '', editReady: true, direction: 'received',
    personName: '', amount: '', happenedOn: todayLocal(), pickerDate: todayLocal(), note: '',
    saving: false, deleting: false, formError: '',
    returnForEntryId: '', receivedAmountYuan: '', receivedDate: '',
    linkedReceiptId: '', linkedSourceLedgerId: '', unlinking: false,
    returnLedgers: [], returnLedgerNames: [], targetLedgerIndex: 0, targetLedgerId: '', returnReady: false
  },

  onLoad(options) {
    const selected = getCurrentLedger();
    if (!selected || !options.ledgerId || selected.id !== (options.contextLedgerId || options.ledgerId)) {
      this.setData({ formError: '账本已切换，请返回往来页重新打开。' });
      return;
    }
    this.setData({ ledgerId: options.ledgerId, contextLedgerId: selected.id, ledgerName: selected.name });
    if (options.returnForEntryId) {
      let personName = '';
      try { personName = decodeURIComponent(options.personName || ''); } catch (_) { personName = options.personName || ''; }
      this.setData({
        returnForEntryId: options.returnForEntryId, direction: 'given', personName,
        receivedAmountYuan: (Number(options.receivedAmountFen) / 100).toFixed(2),
        receivedDate: options.receivedDate || '', targetLedgerId: selected.id,
        formError: ''
      });
      this.loadReturnLedgers();
      return;
    }
    if (options.entryId) {
      this.setData({ editingId: options.entryId, editReady: false, formError: '正在读取记录…' });
      this.getOpenerEventChannel().on('editEntry', entry => {
        if (!entry || entry.id !== options.entryId) return;
        this.setData({
          direction: entry.direction, personName: entry.personName,
          amount: entry.amountYuan, happenedOn: entry.happenedOn,
          note: entry.note || '', ledgerName: entry.ledgerName || selected.name,
          linkedReceiptId: entry.returnForEntryId || '', linkedSourceLedgerId: entry.returnForLedgerId || '',
          editReady: true, formError: ''
        });
      });
    }
  },

  async loadReturnLedgers() {
    try {
      const response = await wx.cloud.callFunction({ name: 'entries', data: { action: 'returnLedgerChoices', ledgerId: this.data.ledgerId } });
      const ledgers = response.result && response.result.ledgers;
      if (!Array.isArray(ledgers) || !ledgers.some(item => item.id === this.data.ledgerId)) throw new Error('回礼账本列表不可用');
      const index = ledgers.findIndex(item => item.id === this.data.ledgerId);
      this.setData({ returnLedgers: ledgers, returnLedgerNames: ledgers.map(item => item.name), targetLedgerIndex: index, targetLedgerId: ledgers[index].id, returnReady: true });
    } catch (error) {
      console.error('加载回礼账本失败', error);
      this.setData({ formError: '回礼账本加载失败，请返回后重试。' });
    }
  },

  chooseDirection(event) { if (!this.data.returnForEntryId) this.setData({ direction: event.currentTarget.dataset.direction }); },
  onPersonNameInput(event) { this.setData({ personName: event.detail.value, formError: '' }); },
  onAmountInput(event) { this.setData({ amount: event.detail.value, formError: '' }); },
  onDateChange(event) { this.setData({ happenedOn: event.detail.value }); },
  clearDate() { this.setData({ happenedOn: '' }); },
  onNoteInput(event) { this.setData({ note: event.detail.value }); },
  onTargetLedgerChange(event) {
    const index = Number(event.detail.value);
    const ledger = this.data.returnLedgers[index];
    if (ledger) this.setData({ targetLedgerIndex: index, targetLedgerId: ledger.id });
  },

  async createEntry() {
    if (!this.data.ledgerId || this.data.saving || this.data.deleting) return;
    if (this.data.editingId && !this.data.editReady) return;
    if (this.data.returnForEntryId && !this.data.returnReady) return;
    const selected = getCurrentLedger();
    if (!selected || selected.id !== (this.data.contextLedgerId || this.data.ledgerId)) {
      this.setData({ formError: '账本已切换，请返回往来页重新打开。' }); return;
    }
    const personName = this.data.personName.trim();
    const amount = this.data.amount.trim();
    if (!personName) { this.setData({ formError: '请填写往来对象。' }); return; }
    if (!amount) { this.setData({ formError: '请输入金额。' }); return; }
    if (/^0(?:\.0{1,2})?$/.test(amount)) { this.setData({ formError: '金额必须大于 0 元。' }); return; }
    if (/^\d+\.\d{3,}$/.test(amount)) { this.setData({ formError: '金额最多保留两位小数。' }); return; }
    if (!AMOUNT_PATTERN.test(amount)) { this.setData({ formError: '请输入有效金额，整数最多 8 位。' }); return; }
    this.setData({ saving: true, formError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'entries', data: {
        action: this.data.returnForEntryId ? 'createReturn' : this.data.editingId ? 'update' : 'create',
        ledgerId: this.data.ledgerId, entryId: this.data.editingId || undefined,
        direction: this.data.direction, personName, amount,
        happenedOn: this.data.happenedOn, note: this.data.note,
        receivedEntryId: this.data.returnForEntryId || undefined,
        targetLedgerId: this.data.returnForEntryId ? this.data.targetLedgerId : undefined
      } });
      if (!response.result || !(response.result.entryId || response.result.updated)) throw new Error('云函数未确认保存成功');
      wx.showToast({ title: this.data.returnForEntryId ? '回礼已保存' : '记录已保存', icon: 'success' });
      wx.navigateBack();
    } catch (error) {
      console.error('保存礼金记录失败', error);
      this.setData({ formError: '保存失败，请重试；如持续失败请反馈。' });
    } finally { this.setData({ saving: false }); }
  },

  async deleteEntry() {
    if (!this.data.editingId || !this.data.editReady || !this.data.ledgerId || this.data.saving || this.data.deleting) return;
    const selected = getCurrentLedger();
    if (!selected || selected.id !== (this.data.contextLedgerId || this.data.ledgerId)) {
      this.setData({ formError: '账本已切换，请返回往来页重新打开。' }); return;
    }
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: '删除这笔记录？',
        content: `将删除与${this.data.personName}的往来记录，删除后无法恢复。`,
        confirmText: '确认删除', confirmColor: '#b34435',
        success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false)
      });
    });
    if (!confirmed) return;
    const ledgerId = this.data.ledgerId;
    const entryId = this.data.editingId;
    this.setData({ deleting: true, formError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'entries', data: { action: 'delete', ledgerId, entryId } });
      if (!response.result || !response.result.deleted) throw new Error('云函数未确认删除成功');
      wx.showToast({ title: '记录已删除', icon: 'success' });
      wx.navigateBack();
    } catch (error) {
      console.error('删除礼金记录失败', error);
      this.setData({ formError: /先删除关联的回礼/.test(error.message || '') ? '请先删除关联的回礼，再删除这笔收礼。' : '删除失败，请重试。' });
    } finally { this.setData({ deleting: false }); }
  },

  async unlinkReturn() {
    if (!this.data.editingId || !this.data.linkedReceiptId || !this.data.linkedSourceLedgerId || this.data.saving || this.data.deleting || this.data.unlinking) return;
    const selected = getCurrentLedger();
    if (!selected || selected.id !== (this.data.contextLedgerId || this.data.ledgerId)) {
      this.setData({ formError: '账本已切换，请返回往来页重新打开。' }); return;
    }
    const confirmed = await new Promise(resolve => wx.showModal({
      title: '解除回礼关联？', content: '这笔送礼仍会保留，只是不再作为原收礼的回礼。',
      success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false)
    }));
    if (!confirmed) return;
    this.setData({ unlinking: true, formError: '' });
    try {
      const response = await wx.cloud.callFunction({ name: 'entries', data: {
        action: 'unlinkReturn', ledgerId: this.data.linkedSourceLedgerId,
        receivedEntryId: this.data.linkedReceiptId,
        targetLedgerId: this.data.ledgerId, returnEntryId: this.data.editingId
      } });
      if (!response.result || !response.result.unlinked) throw new Error('解除关联未保存');
      wx.showToast({ title: '已解除关联', icon: 'success' });
      wx.navigateBack();
    } catch (error) {
      console.error('解除回礼关联失败', error);
      this.setData({ formError: '解除关联失败，请重试。' });
    } finally { this.setData({ unlinking: false }); }
  }
});
