function key(openid) {
  return `giftLedger:selected:${openid}`;
}

function getCurrentLedger() {
  const openid = getApp().globalData.openid;
  if (!openid) return null;
  const ledger = wx.getStorageSync(key(openid));
  return ledger && typeof ledger.id === 'string' && typeof ledger.name === 'string' ? ledger : null;
}

function setCurrentLedger(ledger) {
  const openid = getApp().globalData.openid;
  if (!openid) return;
  wx.setStorageSync(key(openid), {
    id: ledger.id,
    name: ledger.name,
    shared: Boolean(ledger.shared),
    ownerLabel: ledger.shared && typeof ledger.ownerLabel === 'string' ? ledger.ownerLabel : ''
  });
}

function clearCurrentLedger() {
  const openid = getApp().globalData.openid;
  if (openid) wx.removeStorageSync(key(openid));
}

module.exports = { getCurrentLedger, setCurrentLedger, clearCurrentLedger };
