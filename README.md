# Cursor Learn 中文同步字幕

在 Cursor 官方教程站 [cursor.com/cn/learn](https://cursor.com/cn/learn) 上，让英文视频在**视频正下方**同步显示中文字幕。

页面正文虽是中文，但视频口播/字幕是英文，且「沉浸式翻译」等工具对该站的 **Mux 播放器无效**。本项目提供**浏览器侧**方案：

> 拉取 Mux 官方英文字幕（HLS + VTT）→ 机翻中文并缓存 → 按 `currentTime` 在视频正下方实时同步显示。

支持「中英双语」开关与「重新翻译」，不修改 Cursor 官网本身。

---

## 两种安装方式（任选其一）

### 方式 A：Tampermonkey 用户脚本（最简单）

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox 均可）。
2. 点击下面的**一键安装**链接（Tampermonkey 会自动识别 `.user.js` 并弹出安装页）：

   - 当前分支（立即可用）：
     ```
     https://raw.githubusercontent.com/tiffen-huang/cursor_test/cursor/learn-zh-subs-sync-7001/cursor-learn-zh-subs.user.js
     ```
   - 合并到默认分支 `main` 后（推荐长期使用）：
     ```
     https://raw.githubusercontent.com/tiffen-huang/cursor_test/main/cursor-learn-zh-subs.user.js
     ```

3. **（Chrome/Edge 必做）启用「允许用户脚本」**：新版 Chrome/Edge 要求为 Tampermonkey 单独开启此权限，否则脚本不会运行（Tampermonkey 会在页面右上角提示「请启用『允许用户脚本』」）。
   - 打开 `chrome://extensions`（Edge 为 `edge://extensions`）→ 打开右上角「开发者模式」。
   - 点 Tampermonkey 的「详情 / Details」→ 打开「允许用户脚本 / Allow user scripts」开关。
4. 打开任意课程页，例如 <https://cursor.com/cn/learn/how-ai-models-work>，视频下方会自动出现中文同步字幕。

### 方式 B：Chrome / Edge 扩展（MV3）

1. 下载本仓库 `chrome-extension/` 目录（或克隆整个仓库）。
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
3. 打开右上角 **开发者模式 / Developer mode**。
4. 点击 **加载已解压的扩展程序 / Load unpacked**，选择 `chrome-extension/` 目录。
5. 打开任意 Cursor Learn 课程页即可。

---

## 使用说明

- 打开课程页后，脚本会在视频容器（`.aspect-video`）**正下方**插入一个 sticky 面板。
- 面板顶部有状态（加载 / 翻译进度 / 就绪）与两个按钮：
  - **双语：开/关** —— 是否在中文下方显示英文原文。
  - **重新翻译** —— 清除该课程缓存并重新抓取翻译。
- 拖动进度条时，字幕会跟随 `currentTime` 实时切换。
- 翻译结果按 `playbackId` 缓存在 `localStorage`，二次打开秒开。

---

## 工作原理

1. 匹配 `https://cursor.com/*/learn*`，找到页面中的 `mux-player` / `mux-video` / `video` 元素。
2. 读取其 `playback-id` 属性（读不到则用内置 `slug → playbackId` 兜底表）。
3. 请求 `https://stream.mux.com/<playbackId>.m3u8`，从 `#EXT-X-MEDIA:TYPE=SUBTITLES`（优先 `LANGUAGE=en*`）拿到字幕媒体清单。
4. 下载各 VTT 分片，解析并**按起始时间去重**（相邻分片会有重叠 cue）合并。
5. 用 Google 翻译 gtx 接口**批量**翻成中文（多条以 `\n` 拼接，响应保留 `\n` 便于对齐），并缓存。
6. `requestAnimationFrame` 循环读取 `currentTime`，二分查找当前 cue 并渲染。

字幕与翻译请求存在跨域限制，因此：

- **用户脚本**使用 `GM_xmlhttpRequest`（已在 `@connect` 声明 `mux.com` / `googleapis.com`）。
- **扩展**由 `background.js`（service worker，持有 `host_permissions`）代理请求，`content.js` 通过消息与之通信。

---

## 文件结构

| 文件 | 作用 |
|------|------|
| `cursor-learn-zh-subs.user.js` | Tampermonkey 用户脚本（单文件、内联核心逻辑） |
| `chrome-extension/manifest.json` | MV3 扩展清单 |
| `chrome-extension/background.js` | 跨域 fetch 代理（service worker） |
| `chrome-extension/content.js` | 注入页面，提供基于消息的 `httpGet` |
| `chrome-extension/core.js` | 与用户脚本一致的共享核心逻辑 |

---

## 已知限制

- 依赖 Mux 官方**英文**字幕轨；若某课程没有字幕轨则无法显示。
- 使用非官方 Google 翻译 gtx 接口，可能偶发限流；已做批量+缓存+逐条兜底降低影响。
- 翻译质量为机器翻译，仅供辅助理解。

## 许可证

MIT
