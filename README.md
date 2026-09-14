# dsh-gemini-web

把 **Google Gemini 网页端（gemini.google.com）** 接进 DeepSeek Harness：在 DSH 设置里点一下「登录 Google」即可完成登录，插件自动把登录态写入内置反代内核，并注册原生 `gemini-web` provider。不需要手工跑程序、不需要复制粘贴 cookie。

挂上登录态后可用 `gemini-3.1-pro`、`gemini-3.8-flash`、各模型的扩展思考版，以及生图 / 生音乐 / 生视频等模型；不登录也能用匿名的两个 Flash 模型。

## 安装

用 dsh 自带的插件命令从 GitHub 安装：

```bash
dsh plugin --profile web add github:dtsummery/dsh-gemini-web
```

- `web` 是目标 profile 名（DSH Desktop 默认 profile 就叫 `web`）。
- 这个命令会顺带把插件登记进该 profile `package.json` 的 `dsh.profile.bundles`，不需要手工改配置。
- 输出里出现 `+ dsh-gemini-web github:dtsummery/dsh-gemini-web` 即为成功，然后**重启 DSH Desktop**。

卸载用同一套命令：

```bash
dsh plugin --profile web remove dsh-gemini-web
```

环境要求：已安装 dsh CLI（`dsh --version` 可查版本）、Node ≥ 22；`dsh plugin` 内部使用 pnpm。

插件的数据都放在 `~/.dsh/gemini-web/`：

| 路径 | 用途 |
| --- | --- |
| `bin/gemini-web2api-go.exe` | 反代内核，首次使用在设置页点「下载 / 更新内核」 |
| `kernel.db` | 内核数据（Cookie 池、代理池、请求记录） |
| `kernel.env` | 内核凭据与监听端口 |
| `browser-profile/` | 插件专属浏览器 profile，登录态保存在这里 |

## 使用

1. 重启 DSH Desktop。
2. 打开 **设置 → Gemini 网页端**（插件自带一页独立设置），确认「启用 Gemini 网页端 provider」已勾选。
3. 首次使用点 **下载 / 更新内核**，等页面显示「内核 运行中」。
4. 点 **登录 Google**，在弹出的浏览器窗口里正常登录 Gemini，然后回到设置页点 **我已完成登录**。
5. 模型列表里出现 **Gemini 网页端** 下的模型即可直接使用。

登录成功后插件会自动开启 **cookie 保活**，设置页显示「保活 运行中」：Google 换发登录票时会自动回写内核，正常情况下不需要再手动登录；想立刻检查可点 **立即保活**。

> 保活会常驻一个**无窗口**的 headless 浏览器（用来维持 Google 的设备绑定会话轮转），看不到窗口、只占少量内存。不需要就取消「自动保活 cookie」，代价是 Google 换票后需要重新登录。

## 配置项

| 字段 | 说明 |
| --- | --- |
| 启用 Gemini 网页端 provider | 关掉则不注册 provider、不起内核 |
| 自动保活 cookie | 常驻无窗口浏览器维持登录票轮转并回写内核；关掉后 Google 一换票就会掉登录 |
| 保活检查间隔（分钟） | 多久读一次浏览器 cookie 并比对登录票，1–120，默认 5 |
| 出口代理 | 内核访问 Google 用的代理；留空沿用 DSH 进程的 `HTTPS_PROXY` / `HTTP_PROXY` |
| 浏览器路径 | 留空自动探测 Chrome / Edge |
| 反代内核路径 | 留空用 `~/.dsh/gemini-web/bin/` |
| 内核端口 | 0 = 首次启动自动挑一个空闲端口并记住 |

## 排障

| 现象 | 处理 |
| --- | --- |
| 页面显示「尚未下载反代内核」 | 点「下载 / 更新内核」（走配置的出口代理） |
| 连通性测试失败 | 多为出口代理不可用；换代理地址或确认代理软件在运行，然后点「重启内核」 |
| 选 Pro 报错 | 未登录或登录态失效，重新走一次「登录 Google → 我已完成登录」 |
| 页面显示「保活 待命 / 保活失败」 | 看该行备注里的原因：还没登录、保活浏览器起不来、或 profile 被别的窗口占用；点「立即保活」重试 |
| 模型请求报 502 | 内核出口被 Google 拦或代理挂了；换代理后点「重启内核」 |
| 登录窗口提示「此浏览器或应用可能不安全」 | 登录窗口带了自动化参数；确认浏览器路径指向普通 Chrome/Edge，且没有别的进程占用同一个 profile 目录 |
| 点「我已完成登录」提示缺少登录态 cookie | 窗口里其实还没登录成功；在窗口里打开 gemini.google.com 确认能正常对话，再点一次 |

## 使用注意

- **没有真正的 function calling**：内核是 prompt 级实现，工具调用不如原生 provider 稳，建议作为问答 / 生图线路使用。
- **上下文硬墙约 13 万 UTF-8 字节**：超了上游会从尾部静默截断，长对话请自行压缩。
- **单 IP 风控**：同一出口突发 80–180 次请求会被 Google 拦约 2 小时；高频使用建议在内核面板（`http://127.0.0.1:<端口>/admin`）里加代理池。
- **登录态是设备绑定的**：新版 Chrome/Edge 的 Google 会话绑定设备，登录票只有浏览器能续期——插件靠常驻保活解决，所以不要关掉保活，也不要在保活运行时用别的窗口去占用它的 profile。
