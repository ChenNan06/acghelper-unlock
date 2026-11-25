# src/addons/webdav —— WebDAV 云同步（ACGhelper 2.8.31.16 解锁版新增功能）

替代/并存官方会员服务器云同步（`https://acghelper.com/g` 的 GraphQL）：把同一份设置 JSON 搬到**用户自己的 WebDAV**。
完整说明见 `docs/webdav-sync.md`。

## 文件

| 文件 | 说明 |
| --- | --- |
| `html/webdav.html` | 同步主页面（配置 / 测试 / 上传 / 下载 / 差异 / 自动同步 / 状态 / 日志） |
| `js/webdav-core.js` | 共享核心库（经典脚本，暴露 `self.ACHWebDAV`）：官方协议采集、官方协议下发、原始 storage 快照降级、WebDAV 客户端（逐级 MKCOL + GET 回读 sha256）、历史快照、冲突判定、alarm 调度 |
| `js/webdav.js` | 页面逻辑 |
| `js/webdav-sw.js` | Service Worker 侧引导：注册 `chrome.alarms.onAlarm`（由 `initBackground.sw.js` 尾部 `importScripts` 载入） |
| `inject.js` | 配置页右下角浮动入口（不碰 React bundle） |

## 入口

1. 扩展的**设置/选项页**（`html/config.html`）右下角 → 「☁ WebDAV 同步」
2. 快捷键 `Alt+Shift+W`
3. 直接访问 `chrome-extension://<扩展ID>/html/webdav.html`

## 关键约束（改代码前先读）

- **不要给 `app` 发 `getSettingsForUpload`**：那条聚合通道恒返回 `{}`（handler 丢掉了回调结果），必须**逐控制器**发。
- **PUT 之后必须 GET 回读 + sha256**：服务端（Apache mod_dav）不回 ETag。
- **PUT 前必须逐级 MKCOL**：父目录不存在时服务端返回 403，不是 404。
- **不要加条件请求头**：不同服务商行为不一致；本实现靠回读校验。
- **只在 `_acghelper/` 下建目录**，探活用 `_probe` 且用完删。
- 比对一致性要按**设置内容指纹**（`settingsFingerprint`，键序归一化、不含 `exportedAt`），整包字节比对永远不等。
