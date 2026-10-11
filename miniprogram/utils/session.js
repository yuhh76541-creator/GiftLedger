let pendingLogin;

function ensureLogin() {
  const app = getApp();
  if (app.globalData.openid) return Promise.resolve(app.globalData.openid);
  if (!wx.cloud || !app.globalData.env) return Promise.reject(new Error('云开发环境未配置'));
  if (!pendingLogin) {
    pendingLogin = wx.cloud.callFunction({ name: 'login' }).then(response => {
      const openid = response.result && response.result.openid;
      if (!openid) throw new Error('login 云函数没有返回 OpenID');
      app.globalData.openid = openid;
      app.globalData.nickname = typeof response.result.nickname === 'string' ? response.result.nickname : '';
      return openid;
    }).finally(() => { pendingLogin = null; });
  }
  return pendingLogin;
}

module.exports = { ensureLogin };
