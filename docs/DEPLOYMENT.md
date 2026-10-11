# 独立环境部署清单

这份清单供开发者在**自己的**小程序和云开发环境中复现项目。不要把真实用户数据、邀请码、密钥或数据库导出文件提交到 Git。

1. 在微信开发者工具导入仓库，将 `project.config.json` 的 `appid` 和 `miniprogram/app.js` 的 `env` 改为自己的 AppID、云环境 ID。
2. 在该云环境创建 `users`、`ledgers`、`entries`、`ledgerMembers`、`ledgerInvites` 五个集合。
3. 将这五个集合的客户端读写权限设为仅管理端可访问；本项目的客户端不直接读写数据库，而是经云函数完成业务鉴权。不要设置成“所有用户可读”或“所有用户可写”。
4. 按查询情况检查并建立索引（均为非唯一；`_id` 自带索引）：

   | 集合 | 索引字段与顺序 |
   | --- | --- |
   | `entries` | `ledgerId` 升序、`happenedOn` 降序、`_id` 降序 |
   | `entries` | `returnForEntryId` 升序 |
   | `ledgers` | `ownerOpenid` 升序、`createdAt` 降序、`_id` 降序 |
   | `ledgerMembers` | `memberOpenid` 升序、`joinedAt` 降序、`_id` 降序 |
   | `ledgerInvites` | `ledgerId` 升序、`expiresAt` 降序、`_id` 降序 |

5. 在微信开发者工具分别部署 `cloudfunctions/login`、`cloudfunctions/ledgers`、`cloudfunctions/entries`，选择“上传并部署：云端安装依赖”。`entries` 依赖 `pinyin-pro`，不能只替换云端代码。
6. 编译并用测试账号验证：首次登录、建账本、两账号共享与撤销、收送礼、跨账本回礼、搜索、CSV 导入导出、无权访问拒绝。
7. 提审前核对小程序隐私保护指引与实际使用的剪贴板、聊天文件选择等能力；确认数据库备份及回档方案。CSV 不保存回礼关联，不应作为唯一备份。

早期版本包含云开发模板示例 `quickstartFunctions`，当前源码已移除。若你的环境中曾部署它，请在云开发控制台单独核查并停用；删除仓库目录不会自动删除已部署云函数。
