# dsh-gemini-web

把 **Google Gemini 网页端（gemini.google.com）** 接进 DeepSeek Harness：在 DSH 设置里点一下「登录 Google」，插件用受控浏览器完成登录并直接读取 cookie，然后在后台托管反代内核、注册原生 `gemini-web` provider。不需要手工跑程序、不需要复制粘贴 cookie。

## 它做什么

```
DSH provider: gemini-web  ──HTTP/SSE──▶  本机反代内核（gemini-web2api-go）
                                              └─ 逆向 gemini.google.com 网页协议 ──▶ 你的 Google 账号
受控 Chrome/Edge 窗口  ──CDP 读 cookie──▶  内核 Cookie 池（登录凭据）
```

- **host 侧**（`lib/index.js`）：托管内核进程（启动、健康检查、卸载时回收）、注册 `gemini-web` provider、提供设置页用的 HTTP 路由、cookie 保活定时同步。
- **登录**（`lib/edge-login.js`）：拉起一个插件专属 profile 的 Chrome/Edge，打开 gemini.google.com，轮询到登录态 cookie 齐备后自动抓取并写入内核，全程免粘贴。
- **适配器**（`lib/adapter.js`）：把内核的 OpenAI 兼容 SSE 翻译成 DSH 的 StreamChunk（文本 / thinking / tool call / usage）。
- **设置卡片**（`lib/client.js`）：状态、登录、退出、重启内核、下载内核、连通性测试与全部配置项。

## 安装（从 GitHub）

在 DSH web profile 目录下安装：

```bash
npm install github:dtsummery/dsh-gemini-web
```

或把 `~/.dsh/profiles/web/package.json` 的依赖写成 GitHub 地址，再执行 `npm install`：

```json
"dsh-gemini-web": "github:dtsummery/dsh-gemini-web"
```

同时确保 `dsh-gemini-web` 已列在 `dsh.profile.bundles` 里，然后重启 DSH Desktop（新增 bundle 需要重新装配）。

- 安装形态：`~/.dsh/profiles/web/node_modules/dsh-gemini-web` 是从 GitHub 拉取的实体目录，不是指向本地工作区的 junction；
- 反代内核：`~/.dsh/gemini-web/bin/gemini-web2api-go.exe`（首次使用可在设置卡片里点「下载 / 更新内核」）；
- 运行数据：`~/.dsh/gemini-web/`（`kernel.env` 凭据、`kernel.db`、`browser-profile` 浏览器登录态）。

**插件本体以 GitHub 仓库为准**：改代码后先 push 到 GitHub，再重新安装该依赖才会生效。

## 使用

1. 重启 DSH Desktop（新增 bundle 需要重新装配）。
2. 打开 **设置 → 插件 → Gemini 网页端**。
3. 点 **登录 Google** → 弹出的浏览器窗口里正常登录 → 回到设置卡片点 **我已完成登录**。
   登录窗口**不带任何自动化参数**（Google 登录页会拒绝带远程调试端口的浏览器，报「此浏览器或应用可能不安全」）；点确认后插件才关掉窗口、以调试模式（不访问 Google 页面）读一次 cookie 写入内核，卡片显示「登录成功，已写入内核 Cookie 池」。
4. 模型列表里出现 **Gemini 网页端** 下的模型（匿名只有 `gemini-3.6-flash` / `gemini-3.5-flash-lite`；挂了 cookie 才有 `gemini-3.1-pro`、`gemini-3.8-flash`、`gemini-image` 等）。
5. 不登录也能用匿名两个模型，但选 `gemini-3.1-pro` 会直接报错——这是内核的故意设计（避免被静默降级成 3.5 Flash-Lite 却以为是 Pro）。

## 配置项

| 字段 | 说明 |
| --- | --- |
| 启用 Gemini 网页端 provider | 关掉则不注册 provider、不起内核 |
| 出口代理 | 内核访问 Google 用的代理；留空沿用 DSH 进程的 `HTTPS_PROXY`/`HTTP_PROXY` |
| 浏览器路径 | 留空自动探测 Chrome / Edge |
| 反代内核路径 | 留空用 `~/.dsh/gemini-web/bin/` |
| 内核端口 | 0 = 首次启动自动挑一个空闲端口并记住 |

## 已知限制

- **没有真正的 function calling**：内核是 prompt 级实现（让模型吐 `tool_call` 块再正则解析），DSH 的重工具链不如原生 provider 稳，建议作为问答/生图线路，不要当主 agent 模型。
- **上下文硬墙约 13 万 UTF-8 字节**：超了上游从尾部静默截断，所以 DSH 里 contextWindow 标成 40000。
- **单 IP 风控**：突发 80–180 次请求会被 Google 302 到 sorry 页并硬拦约 2 小时；高频使用需要在面板里加代理池（内核管理面板：`http://127.0.0.1:<端口>/admin`）。
- **cookie 续期**：内核自己会用哨兵 payload 续期 `__Secure-1PSIDTS`；若 Google 的设备绑定会话（Chrome/Edge 新版）让续期失败，卡片会提示 cookie 失效，重新走一次「登录 Google → 我已完成登录」即可（登录态留在插件专属 profile 里，通常不用重新输密码）。

## 排障

| 现象 | 处理 |
| --- | --- |
| 设置卡片显示「尚未下载反代内核」 | 点「下载 / 更新内核」（走上面配置的代理） |
| 连通性测试失败 | 多为出口代理不可用；换代理地址或确认代理软件在跑 |
| 选 Pro 报错 | 未登录或 cookie 失效，重新走一次「登录 Google → 我已完成登录」 |
| 登录窗口里提示「此浏览器或应用可能不安全」 | 说明登录窗口带了自动化参数：确认浏览器路径指向普通 Chrome/Edge，且没有别的进程占用同一个 profile 目录 |
| 点「我已完成登录」提示缺少登录态 cookie | 窗口里其实还没登录成功（或登录的是别的账号页）；在窗口里打开 gemini.google.com 确认能正常对话再点一次 |
| 模型请求报 502 upstream error | 内核的出口被 Google 拦或代理挂了，在卡片里换代理后点「重启内核」 |
| 想彻底卸载 | 删除 `~/.dsh/profiles/web/node_modules/dsh-gemini-web`（junction）、从 `package.json` 的 `dependencies`/`dsh.profile.bundles` 移除 `dsh-gemini-web`，再删 `~/.dsh/gemini-web/` |
