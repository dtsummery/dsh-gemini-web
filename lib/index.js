/**
 * dsh-gemini-web — host 侧插件。
 *
 * 把 Google Gemini 网页端（gemini.google.com）接进 DSH：
 * 1. 托管单文件反代内核 gemini-web2api-go（启动、健康检查、退出时回收）；
 * 2. 在设置里点「登录」时拉起一个插件专属 profile 的 Chrome/Edge，用户正常登录后
 *    直接读取浏览器里的 Google cookie 并写入内核的 Cookie 池（免复制粘贴）；
 * 3. 用 {@link GeminiWebAdapter} 把 `gemini-web` 这个 provider 注册进 DSH 的 LLM 服务。
 *
 * 配置位于 `gemini-web` settings 命名空间（设置 → 插件 → Gemini 网页端），改动即时生效。
 *
 * @module dsh-gemini-web
 */
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  Kernel,
  KERNEL_VERSION,
  downloadKernel,
  findFreePort,
  readKeyValueFile,
  writeKeyValueFile
} from './kernel.js'
import {
  LoginBrowser,
  REQUIRED_COOKIES,
  browserProcessName,
  cookieHeaderFrom,
  detectBrowser,
  systemUserDataDir
} from './edge-login.js'
import { GeminiWebAdapter } from './adapter.js'

/** Cordis 插件名。 */
export const name = 'dsh-gemini-web'

/** 需要就绪的服务：LLM 注册表与设置服务。 */
export const inject = ['llm', 'settings']

/** 注册给 DSH 的 provider 路由名。 */
const PROVIDER_ID = 'gemini-web'

/** 插件设置命名空间。 */
const NS = settingsNamespace('gemini-web')

/** 组合行配置（同时是设置 schema）。 */
const Config = z.object({
  /** 总开关：关闭时不启动内核、不注册 provider。 */
  enabled: z.boolean().default(true),
  /** 反代内核可执行文件路径；留空使用 ~/.dsh/gemini-web/bin/ 下的自动路径。 */
  kernelPath: z.string().default(''),
  /** 内核监听端口；0 = 首次启动时自动选一个空闲端口并记住。 */
  port: z.number().default(0),
  /** 内核出口代理，留空时沿用 DSH 进程里的 HTTPS_PROXY/HTTP_PROXY。 */
  proxyUrl: z.string().default(''),
  /** 受控浏览器可执行文件路径；留空自动探测 Chrome/Edge。 */
  browserPath: z.string().default(''),
  /** 允许 DSH 把「网页端模型不支持真正的工具调用」这一限制写进系统提示。 */
  exposeLimitationNotice: z.boolean().default(true)
})

/** 状态目录：内核、凭据、浏览器 profile 都落在这里。 */
function stateDir() {
  return join(homedir(), '.dsh', 'gemini-web')
}

/**
 * 把若干配置来源合并成一份完整配置。
 *
 * settings 服务给出的 namespace 值可能是空对象（用户从没在设置界面里改过），
 * 这时必须回退到组合行配置的默认值 —— 否则 `enabled` 会变成 `undefined`，
 * 被误判成"插件已停用"，连内核对都拿不到。
 * @param {...object} sources - 从低优先级到高优先级的配置来源。
 * @returns {{enabled: boolean, kernelPath: string, port: number, proxyUrl: string, browserPath: string, exposeLimitationNotice: boolean}}
 */
function normalizeConfig(...sources) {
  const merged = Object.assign({}, ...sources.filter((source) => source && typeof source === 'object'))
  const port = Number(merged.port)
  return {
    enabled: merged.enabled !== false,
    kernelPath: typeof merged.kernelPath === 'string' ? merged.kernelPath : '',
    port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 0,
    proxyUrl: typeof merged.proxyUrl === 'string' ? merged.proxyUrl : '',
    browserPath: typeof merged.browserPath === 'string' ? merged.browserPath : '',
    exposeLimitationNotice: merged.exposeLimitationNotice !== false
  }
}

/** 生成一次性的随机凭据。 */
function randomSecret(prefix = '') {
  return prefix + randomBytes(16).toString('hex')
}

/**
 * Cordis 插件入口。
 * @param ctx - host 插件上下文。
 * @param entryConfig - 组合行配置（settings 未覆盖时的初值）。
 */
export function apply(ctx, entryConfig = {}) {
  const tag = '[dsh-gemini-web] '
  const log = (msg) => ctx.logger?.info?.(tag + msg)
  const warn = (msg) => ctx.logger?.warn?.(tag + msg)

  const dir = stateDir()
  mkdirSync(dir, { recursive: true })

  /** 内核凭据（admin token / API key / 端口）持久化在 kernel.env。 */
  const envPath = join(dir, 'kernel.env')
  const stored = readKeyValueFile(envPath)
  const adminToken = stored.ADMIN_TOKEN || randomSecret()
  const apiKey = stored.API_KEY || randomSecret('sk-gemini-')
  let kernelPort = Number(stored.PORT || 0)

  let config = normalizeConfig(entryConfig)
  /** 探测到的系统出口代理：内核访问 Google 必须走它，直连会超时。 */
  let detectedProxy = ''
  let proxyProbed = false
  let kernel = null
  let starting = null
  let loginState = { phase: 'idle', message: '未登录', at: Date.now() }
  let browser = null
  let disposed = false

  const currentConfig = () => config

  /** 内核二进制路径：显式配置 > 状态目录下的默认位置。 */
  const kernelPath = () => {
    const configured = currentConfig().kernelPath
    if (typeof configured === 'string' && configured.length > 0) return configured
    const exe = process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go'
    return join(dir, 'bin', exe)
  }

  /** 出口代理：显式配置 > 探测到的系统代理 > DSH 进程环境里的代理。 */
  const proxyUrl = () => {
    const configured = currentConfig().proxyUrl
    if (typeof configured === 'string' && configured.length > 0) return configured
    if (detectedProxy.length > 0) return detectedProxy
    return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
  }

  const baseUrl = () => `http://127.0.0.1:${kernelPort}/v1`

  /** 确保内核在跑；并发调用共享同一次启动。 */
  const ensureKernel = async () => {
    if (!currentConfig().enabled) throw new Error('插件已在设置里停用：请到「设置 → 插件 → Gemini 网页端」勾选「启用 Gemini 网页端 provider」')
    if (!proxyProbed) {
      detectedProxy = await resolveProxy()
      proxyProbed = true
      log(`内核出口代理：${detectedProxy.length > 0 ? detectedProxy : '(未探测到，内核将直连 Google)'}`)
    }
    if (kernel !== null && kernel.running) return kernel
    if (starting !== null) return starting
    starting = (async () => {
      const binPath = kernelPath()
      if (!existsSync(binPath)) {
        throw new Error(`反代内核不存在：${binPath}（在设置里点「下载内核」，或手动指定路径）`)
      }
      if (!kernelPort) {
        kernelPort = Number(currentConfig().port) || (await findFreePort(8083))
        writeKeyValueFile(envPath, { ADMIN_TOKEN: adminToken, API_KEY: apiKey, PORT: String(kernelPort) })
      }
      const instance = new Kernel({
        binPath,
        port: kernelPort,
        dbPath: join(dir, 'kernel.db'),
        adminToken,
        apiKey,
        proxyUrl: proxyUrl(),
        onLog: (line) => log(line)
      })
      const started = await instance.start()
      kernel = instance
      instance.startCookieGuard({ onLog: (line) => log(line) })
      log(`内核已就绪（端口 ${kernelPort}${started.reused ? '，复用现有实例' : ''}）`)
      return instance
    })().finally(() => {
      starting = null
    })
    return starting
  }

  /** 执行一个短命令并收下输出（用于检测/关闭系统浏览器）。 */
  const runCommand = (file, args) =>
    new Promise((resolve) => {
      execFile(file, args, { windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })

  /**
   * 探测内核的出口代理：显式配置 > Windows 系统代理（Internet Settings） > 进程环境变量。
   *
   * 内核在带 cookie 的请求前要先去 gemini.google.com 取 XSRF token，那一步走的是同一个出口；
   * 探测不到就会直连 Google（本机直连不通），表现为"cookie 池里的账号都不可用"。
   * @returns {Promise<string>} 代理 URL；空串表示直连。
   */
  const resolveProxy = async () => {
    const configured = currentConfig().proxyUrl
    if (typeof configured === 'string' && configured.length > 0) return configured
    if (process.platform === 'win32') {
      const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
      const enabled = await runCommand('reg', ['query', base, '/v', 'ProxyEnable'])
      if (/0x1\b/.test(enabled.stdout)) {
        const server = await runCommand('reg', ['query', base, '/v', 'ProxyServer'])
        const match = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(server.stdout)
        if (match) {
          const perProtocol = /(?:^|;)https?=([^;]+)/.exec(match[1])
          const candidate = (perProtocol ? perProtocol[1] : match[1]).trim()
          if (candidate.length > 0) return /^https?:\/\//.test(candidate) ? candidate : `http://${candidate}`
        }
      }
    }
    return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
  }

  /** 系统浏览器当前是否在运行（它占用 profile 时无法读取 cookie）。 */
  const isBrowserRunning = async (bin) => {
    if (process.platform !== 'win32') return false
    const name = browserProcessName(bin)
    const result = await runCommand('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'])
    return result.stdout.toLowerCase().includes(name.toLowerCase())
  }

  /** 关闭系统浏览器的全部进程（读它的 profile 之前必须先做）。 */
  const killBrowserProcesses = async (bin) => {
    if (process.platform !== 'win32') return
    await runCommand('taskkill', ['/IM', browserProcessName(bin), '/F', '/T'])
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }

  /** 把一份 cookie 串写入内核 Cookie 池（先清掉本插件先前写入的账号）。 */
  const pushCookieToKernel = async (cookie) => {
    const instance = await ensureKernel()
    const existing = await instance.listCookies().catch(() => ({ items: [] }))
    for (const item of existing.items ?? []) {
      if (typeof item.label === 'string' && item.label.startsWith('dsh-gemini-web')) {
        await instance.deleteCookie(item.id).catch(() => {})
      }
    }
    const created = await instance.addCookie(`dsh-gemini-web ${new Date().toISOString().slice(0, 16)}`, cookie, 'DSH 设置页免粘贴登录')
    const check = await instance.checkCookie(created.id).catch(() => undefined)
    if (check && check.ok === false) {
      warn(`写入的 cookie 检测未通过：${check.detail ?? check.error ?? '未知原因'}`)
    }
    return { id: created.id, check }
  }

  /** 一组 cookie 是否包含全部登录态关键项。 */
  const hasRequiredCookies = (cookies) => {
    const names = new Set(cookies.map((c) => c.name))
    return REQUIRED_COOKIES.every((name) => names.has(name))
  }

  /**
   * 设置页第一步：打开一个**不带任何自动化参数**的浏览器窗口，
   * 用户在里面正常登录 Google。带 --remote-debugging-port 的窗口会被
   * Google 登录页判定为"不安全的浏览器/应用"，所以这一步必须干净。
   */
  const startLogin = async () => {
    if (loginState.phase === 'awaiting-confirm' && browser?.loginWindowOpen === true) return loginState
    const bin = detectBrowser(currentConfig().browserPath)
    if (bin === undefined) {
      loginState = { phase: 'error', message: '没找到 Chrome/Edge，请在设置里手动指定浏览器路径', at: Date.now() }
      return loginState
    }
    await browser?.close().catch(() => {})
    browser = new LoginBrowser({
      browserPath: currentConfig().browserPath,
      profileDir: join(dir, 'browser-profile'),
      onLog: (line) => log(line)
    })
    try {
      await browser.openLoginWindow()
      loginState = {
        phase: 'awaiting-confirm',
        message: '浏览器窗口已打开 Gemini 登录页：登录完成后回到这里点「我已完成登录」',
        at: Date.now()
      }
    } catch (error) {
      loginState = { phase: 'error', message: String(error?.message ?? error), at: Date.now() }
      browser = null
    }
    return loginState
  }

  /**
   * 设置页第二步：关掉登录窗口，再以调试模式打开同一 profile 读取 cookie 并写入内核。
   * 读取过程不访问任何 Google 页面，所以不会触发登录页的安全检测。
   */
  const confirmLogin = async () => {
    if (browser === null) {
      loginState = { phase: 'error', message: '登录窗口已关闭，请重新点「登录 Google」', at: Date.now() }
      return loginState
    }
    loginState = { phase: 'reading', message: '正在读取浏览器 cookie…', at: Date.now() }
    try {
      const cookies = await browser.readGoogleCookiesOnce({ timeoutMs: 40000 })
      if (!hasRequiredCookies(cookies)) {
        const names = new Set(cookies.map((c) => c.name))
        const missing = REQUIRED_COOKIES.filter((name) => !names.has(name))
        const sample = [...names].slice(0, 8).join('、')
        // 没读到登录态时把窗口还回去，用户可以继续完成登录后重试。
        await browser.openLoginWindow().catch(() => {})
        loginState = {
          phase: 'awaiting-confirm',
          message: `还没读到登录态（缺少 ${missing.join('、')}；该 profile 当前只有：${sample || '无'}）。请在窗口里确认已经能正常打开 Gemini，再点一次「我已完成登录」`,
          at: Date.now()
        }
        return loginState
      }
      const { check } = await pushCookieToKernel(cookieHeaderFrom(cookies))
      loginState = {
        phase: 'ok',
        message: check && check.ok === false
          ? `已写入 cookie，但内核检测未通过：${check.detail ?? '请重试'}`
          : '登录成功，已写入内核 Cookie 池',
        at: Date.now()
      }
      await browser.close().catch(() => {})
      browser = null
    } catch (error) {
      // 读取环节本身出错（端口超时、profile 被占用等）也把窗口还回去，便于直接重试。
      await browser.openLoginWindow().catch(() => {})
      loginState = {
        phase: 'awaiting-confirm',
        message: `读取 cookie 失败：${String(error?.message ?? error)}。窗口已重新打开，可再次点「我已完成登录」`,
        at: Date.now()
      }
    }
    return loginState
  }

  /** 取消登录：关掉浏览器窗口。 */
  const cancelLogin = async () => {
    await browser?.close().catch(() => {})
    browser = null
    loginState = { phase: 'idle', message: '已取消登录', at: Date.now() }
    return loginState
  }

  /**
   * 从系统默认浏览器（Edge/Chrome）的 profile 里导入登录态。
   * 那里通常已经有用户平时登录好的 Google 会话，所以不需要任何登录交互；
   * 代价是必须先完全关闭该浏览器，让它释放 profile 独占锁。
   * @param {boolean} killFirst - true 时先强杀浏览器进程。
   */
  const importFromSystemBrowser = async (killFirst = false) => {
    const bin = detectBrowser(currentConfig().browserPath)
    if (bin === undefined) return { ok: false, message: '没找到 Chrome/Edge，请在设置里手动指定浏览器路径' }
    const userDataDir = systemUserDataDir(bin)
    if (userDataDir === undefined || !existsSync(userDataDir)) {
      return { ok: false, message: `没找到系统浏览器的用户数据目录：${userDataDir ?? '(未知)'}` }
    }
    if (await isBrowserRunning(bin)) {
      if (!killFirst) {
        return {
          ok: false,
          needClose: true,
          message: `${browserProcessName(bin)} 正在运行、独占着它的 profile。请先完全关闭浏览器，或勾选「先自动关闭浏览器」再点一次`
        }
      }
      log(`正在关闭 ${browserProcessName(bin)} 以读取它的登录态…`)
      await killBrowserProcesses(bin)
    }
    const reader = new LoginBrowser({
      browserPath: currentConfig().browserPath,
      profileDir: userDataDir,
      onLog: (line) => log(line)
    })
    try {
      const cookies = await reader.readGoogleCookiesOnce({ timeoutMs: 45000 })
      if (!hasRequiredCookies(cookies)) {
        const names = [...new Set(cookies.map((c) => c.name))].slice(0, 8).join('、')
        return {
          ok: false,
          message: `系统浏览器里没有 Google 登录态（当前只有：${names || '无'}）；请先在浏览器里登录 gemini.google.com`
        }
      }
      const { check } = await pushCookieToKernel(cookieHeaderFrom(cookies))
      const message = check && check.ok === false
        ? `已从系统浏览器导入，但内核检测未通过：${check.detail ?? '请重试'}`
        : '已从系统浏览器导入登录态'
      loginState = { phase: 'ok', message, at: Date.now() }
      return { ok: true, message }
    } catch (error) {
      return { ok: false, message: `读取系统浏览器 profile 失败：${String(error?.message ?? error)}` }
    } finally {
      await reader.close().catch(() => {})
    }
  }

  /** 退出登录：关掉受控浏览器并清空内核 Cookie 池。 */
  const logout = async () => {
    await browser?.close().catch(() => {})
    browser = null
    try {
      const instance = await ensureKernel()
      const existing = await instance.listCookies().catch(() => ({ items: [] }))
      for (const item of existing.items ?? []) await instance.deleteCookie(item.id).catch(() => {})
    } catch (error) {
      warn(`清空 Cookie 池失败：${String(error)}`)
    }
    loginState = { phase: 'idle', message: '已退出登录', at: Date.now() }
    return loginState
  }

  /** 汇总一份给设置页与诊断用的状态。 */
  const buildStatus = async () => {
    const status = {
      enabled: currentConfig().enabled,
      provider: PROVIDER_ID,
      kernelVersion: KERNEL_VERSION,
      kernelPath: kernelPath(),
      kernelExists: existsSync(kernelPath()),
      port: kernelPort,
      baseUrl: kernelPort ? baseUrl() : '',
      proxyUrl: proxyUrl(),
      browserPath: detectBrowser(currentConfig().browserPath) ?? '',
      browserRunning: browser?.loginWindowOpen === true,
      login: loginState,
      kernel: { running: kernel?.running === true, models: [], cookies: 0, enabled: 0 }
    }
    if (kernel !== null && kernel.running) {
      try {
        status.kernel.models = await kernel.models()
        const pool = await kernel.listCookies()
        status.kernel.cookies = pool.total ?? 0
        status.kernel.enabled = pool.enabled ?? 0
      } catch (error) {
        status.kernel.error = String(error)
      }
    }
    return status
  }

  // ---- 内核与 provider 注册 ----
  const adapterDeps = {
    getBaseUrl: baseUrl,
    getApiKey: () => apiKey,
    log: (msg) => log(msg)
  }

  let adapterDispose = null
  const registerProvider = () => {
    if (adapterDispose !== null) return
    try {
      adapterDispose = ctx.llm.registerAdapter([PROVIDER_ID], new GeminiWebAdapter(adapterDeps))
      log(`已注册 provider 路由：${PROVIDER_ID}`)
    } catch (error) {
      warn(`provider 注册失败：${String(error)}`)
    }
  }
  const unregisterProvider = () => {
    try {
      adapterDispose?.()
    } catch {
      // 注销失败无需处理：fiber 结束时会随插件一起回收。
    }
    adapterDispose = null
  }

  /** 内核在跑但代理池为空时补上出口代理（否则带 cookie 的请求会直连 Google 而失败）。 */
  const ensureProxySeeded = async () => {
    const target = proxyUrl()
    if (target.length === 0) return
    try {
      const instance = await ensureKernel()
      const pool = await instance.listProxies()
      if ((pool.items ?? []).length > 0) return
      await instance.addProxy('dsh-detected', target)
      log(`已给内核补上出口代理：${target}`)
    } catch (error) {
      warn(`补加出口代理失败：${String(error)}`)
    }
  }

  /** 启动内核并确保它带着出口代理。 */
  const bootstrapKernel = () => {
    ensureKernel()
      .then(() => ensureProxySeeded())
      .catch((error) => warn(`内核启动失败：${String(error)}`))
  }

  if (currentConfig().enabled) {
    registerProvider()
    bootstrapKernel()
  }

  // ---- 设置变更：即时生效 ----
  installSettingsSection(ctx, NS, Config, entryConfig, {
    setSource: (next) => {
      config = normalizeConfig(entryConfig, next)
      if (config.enabled) {
        registerProvider()
        bootstrapKernel()
      } else {
        unregisterProvider()
      }
    },
    onChange: () => {
      // 运行期改动只影响下一次内核启动：这里不重启进程，避免打断正在进行的对话。
    }
  })

  // ---- 设置页用的 HTTP 路由 ----
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on?.('data', (chunk) => chunks.push(chunk))
      req.on?.('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          resolve({})
        }
      })
    })

  ctx.inject(['webServer'], (sub) => {
    const webServer = sub.get('webServer')
    if (!webServer) return undefined
    const disposers = []
    const reg = (route) => {
      const dispose = webServer.register(route)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    const guard = (handler) => async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    }

    reg({ kind: 'exact', path: '/plugins/gemini-web/status', handler: guard(async (_req, res) => sendJson(res, 200, await buildStatus())) })
    reg({ kind: 'exact', path: '/plugins/gemini-web/login', handler: guard(async (_req, res) => sendJson(res, 200, await startLogin())) })
    reg({ kind: 'exact', path: '/plugins/gemini-web/login/confirm', handler: guard(async (_req, res) => sendJson(res, 200, await confirmLogin())) })
    reg({ kind: 'exact', path: '/plugins/gemini-web/login/cancel', handler: guard(async (_req, res) => sendJson(res, 200, await cancelLogin())) })
    reg({
      kind: 'exact',
      path: '/plugins/gemini-web/import/system',
      handler: guard(async (req, res) => {
        const body = await readBody(req)
        sendJson(res, 200, await importFromSystemBrowser(body.killFirst === true))
      })
    })
    reg({ kind: 'exact', path: '/plugins/gemini-web/logout', handler: guard(async (_req, res) => sendJson(res, 200, await logout())) })
    reg({
      kind: 'exact',
      path: '/plugins/gemini-web/kernel/restart',
      handler: guard(async (_req, res) => {
        await kernel?.stop().catch(() => {})
        kernel = null
        const instance = await ensureKernel()
        sendJson(res, 200, { ok: true, models: await instance.models() })
      })
    })
    reg({
      kind: 'exact',
      path: '/plugins/gemini-web/kernel/install',
      handler: guard(async (_req, res) => {
        const target = kernelPath()
        const result = await downloadKernel(target, { proxyUrl: proxyUrl() })
        kernel = null
        const instance = await ensureKernel()
        sendJson(res, 200, { ok: true, bytes: result.bytes, models: await instance.models() })
      })
    })
    reg({
      kind: 'exact',
      path: '/plugins/gemini-web/test',
      handler: guard(async (req, res) => {
        const body = await readBody(req)
        const instance = await ensureKernel()
        const result = await instance.test(body.prompt ?? 'Reply with one short word.')
        sendJson(res, 200, result)
      })
    })

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 路由注销失败无需处理。
        }
      }
    }
  })

  // ---- 收尾：停内核、停保活、停浏览器 ----
  ctx.effect(() => {
    return () => {
      disposed = true
      void browser?.close().catch(() => {})
      browser = null
      void kernel?.stop().catch(() => {})
      kernel = null
      unregisterProvider()
      log('插件已卸载：内核与浏览器已停止')
    }
  }, 'gemini-web: cleanup')

  log(`已加载（provider=${PROVIDER_ID}，状态目录 ${dir}）`)
}

/** 供设置页展示：当前使用的内核版本。 */
export const kernelVersion = KERNEL_VERSION

/** 供其它模块读取的配置文件路径（调试用）。 */
export function kernelEnvPath() {
  return join(stateDir(), 'kernel.env')
}

/** 读取当前写入的 API key（调试用，不在 UI 暴露）。 */
export function readKernelEnv() {
  const path = kernelEnvPath()
  if (!existsSync(path)) return {}
  return readKeyValueFile(path)
}

/** 让外部（如 doctor 命令）可以直接读到内核二进制默认路径。 */
export function defaultKernelPath() {
  const exe = process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go'
  return join(stateDir(), 'bin', exe)
}

/** 读取一份文件的文本（给未来诊断用；保持导入面稳定）。 */
export function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
