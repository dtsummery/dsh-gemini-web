/**
 * 受控浏览器登录与 cookie 读取。
 *
 * 拆成两个阶段，原因是 Google 的登录页会拒绝带远程调试端口的浏览器
 * （"此浏览器或应用可能不安全"）：
 *
 * 1. **登录**：用完全干净的参数（只有 --user-data-dir 与目标网址）打开一个
 *    浏览器窗口，用户在窗口里正常登录，不存在任何自动化特征；
 * 2. **读取**：关闭登录窗口后，以调试模式（headless）重新打开同一个 profile，
 *    只连 CDP 读 cookie，不访问 Google 页面 —— 检测脚本没有运行的机会。
 *
 * 依赖：Node 内建 WebSocket（Node 22+）与 fetch，没有第三方依赖。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 登录态必需的关键 cookie（用于判断"是否已经登录"）。 */
export const REQUIRED_COOKIES = ['SID', 'SAPISID', '__Secure-1PSID']

/** 常见 Chromium 浏览器安装位置。 */
export function detectBrowser(explicit) {
  const candidates = [
    explicit,
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 极简 CDP 客户端：连上浏览器级 WebSocket，按 id 匹配响应。 */
class CdpClient {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        message.error ? reject(new Error(message.error.message ?? JSON.stringify(message.error))) : resolve(message.result)
      }
    })
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      // 连接已关闭时无需处理。
    }
  }
}

/** 结束一个浏览器进程及其子进程（Windows 上必须带 /T，否则会留下渲染进程）。 */
async function killTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    try {
      child.kill()
    } catch {
      // 进程可能已经退出。
    }
  }
  await sleep(1200)
}

/** 先请求浏览器正常退出（cookie 才会落盘），超时再强杀整个进程树。 */
async function politeKillTree(child, waitMs = 8000) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    // 进程可能已经退出。
  }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && child.exitCode === null) await sleep(300)
  if (child.exitCode === null) await killTree(child)
}

/**
 * 一个插件专属 profile 的受控浏览器。
 */
export class LoginBrowser {
  /**
   * @param {{browserPath?: string, profileDir: string, onLog?: (line: string) => void}} opts
   */
  constructor(opts) {
    this.opts = opts
    this.loginChild = null
    this.readChild = null
    this.log = opts.onLog ?? (() => {})
  }

  /** 登录窗口是否还开着。 */
  get loginWindowOpen() {
    return this.loginChild !== null && this.loginChild.exitCode === null
  }

  /**
   * 阶段一：打开一个不带任何自动化参数的浏览器窗口，让用户手动登录。
   * @param {string} url - 登录页地址。
   */
  async openLoginWindow(url = 'https://gemini.google.com/app') {
    if (this.loginWindowOpen) return this
    const bin = detectBrowser(this.opts.browserPath)
    if (!bin) throw new Error('没找到 Chrome/Edge，请在插件设置里手动指定浏览器路径')
    mkdirSync(this.opts.profileDir, { recursive: true })
    this.loginChild = spawn(bin, [`--user-data-dir=${this.opts.profileDir}`, url], {
      stdio: 'ignore',
      windowsHide: false,
      detached: false
    })
    this.loginChild.on('exit', (code) => this.log(`[browser] 登录窗口已关闭（code=${code}）`))
    this.log(`[browser] 已打开登录窗口：${bin}`)
    return this
  }

  /** 关闭登录窗口，为"以调试模式读取 cookie"让出 profile 独占权。 */
  async closeLoginWindow() {
    const child = this.loginChild
    this.loginChild = null
    await politeKillTree(child)
  }

  /**
   * 阶段二：以调试模式打开同一 profile，只读 Google cookie，读完立即关闭。
   * 这个过程不访问任何 Google 页面，因此不会触发登录页的安全检测。
   * @param {{timeoutMs?: number}} opts
   * @returns {Promise<Array<any>>} google.com 域下的 cookie。
   */
  async readGoogleCookiesOnce({ timeoutMs = 40000 } = {}) {
    await this.closeLoginWindow()
    const bin = detectBrowser(this.opts.browserPath)
    if (!bin) throw new Error('没找到 Chrome/Edge，请在插件设置里手动指定浏览器路径')
    mkdirSync(this.opts.profileDir, { recursive: true })
    const portFile = join(this.opts.profileDir, 'DevToolsActivePort')
    rmSync(portFile, { force: true })

    this.readChild = spawn(
      bin,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${this.opts.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
      ],
      { stdio: 'ignore', windowsHide: true, detached: false }
    )

    try {
      const deadline = Date.now() + timeoutMs
      let port = 0
      while (Date.now() < deadline) {
        if (existsSync(portFile)) {
          const first = readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0]
          const parsed = Number(first)
          if (Number.isFinite(parsed) && parsed > 0) {
            port = parsed
            break
          }
        }
        await sleep(200)
      }
      if (!port) throw new Error('读取 cookie 用的浏览器未就绪（DevTools 端口超时）')

      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      const ws = new WebSocket(version.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
      })
      const client = new CdpClient(ws)
      try {
        const { cookies } = await client.send('Storage.getCookies', {})
        return cookies.filter((c) => typeof c.domain === 'string' && /(^|\.)google\.com$/.test(c.domain))
      } finally {
        try {
          await client.send('Browser.close')
        } catch {
          // 关不掉也无所谓，下面还会强杀进程。
        }
        client.close()
      }
    } finally {
      const child = this.readChild
      this.readChild = null
      await killTree(child)
      rmSync(portFile, { force: true })
    }
  }

  /** 全部关闭。 */
  async close() {
    await this.closeLoginWindow()
    await killTree(this.readChild)
    this.readChild = null
  }
}

/** 把 CDP 返回的 cookie 数组转成 Cookie 请求头串（只做域名过滤，不改值）。 */
export function cookieHeaderFrom(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

/** 浏览器可执行文件属于 Edge 还是 Chrome。 */
export function browserFamily(browserPath) {
  if (/msedge/i.test(browserPath ?? '')) return 'edge'
  if (/chrome/i.test(browserPath ?? '')) return 'chrome'
  return 'unknown'
}

/** 该浏览器对应的进程名（用于检测/关闭正在运行的实例）。 */
export function browserProcessName(browserPath) {
  return browserFamily(browserPath) === 'chrome' ? 'chrome.exe' : 'msedge.exe'
}

/**
 * 系统默认浏览器的用户数据目录 —— 那里通常已经有用户平时登录好的 Google 登录态，
 * 因此可以跳过登录直接读 cookie（前提是浏览器当前没有在运行）。
 * @param {string} browserPath
 * @returns {string|undefined}
 */
export function systemUserDataDir(browserPath) {
  const local = process.env.LOCALAPPDATA ?? ''
  if (local.length === 0) return undefined
  if (browserFamily(browserPath) === 'edge') return join(local, 'Microsoft', 'Edge', 'User Data')
  if (browserFamily(browserPath) === 'chrome') return join(local, 'Google', 'Chrome', 'User Data')
  return undefined
}
