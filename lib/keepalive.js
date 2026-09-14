/**
 * Cookie 保活浏览器（headless 常驻）。
 *
 * 为什么需要它：新版 Chrome/Edge 的 Google 会话启用了设备绑定会话
 * （Device Bound Session Credentials，DBSC），登录态由 `__Secure-1PSIDTS` 承载，
 * 而这张票只有**持有设备密钥的浏览器**能按 Google 的节奏换发。内核拿到的是一次性
 * 快照，自己调 `RotateCookies` 只能刷到 `SIDCC` 系列，`1PSIDTS` 换发会失败，
 * 于是快照几小时后必然被判为未登录（内核报 `no SNlM0e in page` / `fetch /app: HTTP 302`）。
 *
 * 本模块常驻一个**无窗口**的 headless 浏览器打开 gemini.google.com，让浏览器自己维持
 * DBSC 轮转（实测 18–40 分钟换发一次），上层随时通过 CDP 读回最新 cookie 回写内核。
 * 实测该形态不会被 Google 拒绝，也不会弹出任何窗口。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CdpClient, detectBrowser } from './edge-login.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 保活时关注的登录票 cookie。 */
export const KEEPALIVE_WATCH = ['__Secure-1PSIDTS', '__Secure-1PSIDRTS', '__Secure-3PSIDTS']

/**
 * 取 cookie 数组里的 `1PSIDTS` 值当轮转指纹：它一变就说明 Google 换了新票。
 * @param {Array<{name: string, value: string}>} cookies
 * @returns {string} 指纹；没读到返回空串。
 */
export function rotationFingerprint(cookies) {
  const hit = cookies.find((c) => c.name === '__Secure-1PSIDTS')
  return typeof hit?.value === 'string' ? hit.value : ''
}

/**
 * 常驻 headless 浏览器 + 浏览器级 CDP 连接。
 */
export class KeepAliveBrowser {
  /**
   * @param {{browserPath?: string, profileDir: string, startUrl?: string, onLog?: (line: string) => void}} opts
   */
  constructor(opts) {
    this.opts = opts
    this.log = opts.onLog ?? (() => {})
    this.child = null
    this.client = null
  }

  /** 浏览器进程是否还在。 */
  get running() {
    return this.child !== null && this.child.exitCode === null
  }

  /** CDP 是否已连上。 */
  get connected() {
    return this.client !== null
  }

  /** 进程与连接都可用。 */
  get ready() {
    return this.running && this.connected
  }

  /**
   * 启动常驻实例并连上 CDP；已在运行则直接复用。
   * @returns {Promise<void>}
   */
  async start() {
    if (this.ready) return
    await this.stop()

    const bin = detectBrowser(this.opts.browserPath)
    if (!bin) throw new Error('没找到 Chrome/Edge，无法启动 cookie 保活')
    mkdirSync(this.opts.profileDir, { recursive: true })

    const portFile = join(this.opts.profileDir, 'DevToolsActivePort')
    rmSync(portFile, { force: true })

    this.child = spawn(
      bin,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${this.opts.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        this.opts.startUrl ?? 'https://gemini.google.com/app'
      ],
      { stdio: 'ignore', windowsHide: true }
    )
    this.child.on('exit', (code) => this.log(`[keepalive] 保活浏览器已退出（code=${code}）`))

    const deadline = Date.now() + 30000
    let port = 0
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const parsed = Number(readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0])
        if (Number.isFinite(parsed) && parsed > 0) {
          port = parsed
          break
        }
      }
      await sleep(300)
    }
    if (!port) throw new Error('保活浏览器未就绪（DevTools 端口超时）')

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(10000) })).json()
    const ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
    })
    this.client = new CdpClient(ws)
    this.log('[keepalive] 保活浏览器已启动（headless，无窗口）')
  }

  /**
   * 读一次 google.com 域下的 cookie；连接失效或超时抛出，由上层重建实例。
   * @param {number} timeoutMs - 单次读取超时，避免 CDP 无响应时把调用方挂死。
   * @returns {Promise<Array<any>>}
   */
  async readCookies(timeoutMs = 15000) {
    if (this.client === null) throw new Error('保活浏览器未连接')
    let timer = null
    try {
      const result = await Promise.race([
        this.client.send('Storage.getCookies', {}),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('读取 cookie 超时')), timeoutMs)
          timer.unref?.()
        })
      ])
      return (result?.cookies ?? []).filter((c) => typeof c.domain === 'string' && /(^|\.)google\.com$/.test(c.domain))
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /** 关闭连接并结束进程树（先请求优雅退出，让 cookie 落盘）。 */
  async stop() {
    const client = this.client
    this.client = null
    if (client !== null) {
      try {
        // Browser.close 可能不返回响应，超时兜底，避免 stop() 永挂。
        await Promise.race([client.send('Browser.close'), sleep(2000)])
      } catch {
        // 浏览器已经不可用，下面照样强杀。
      }
      client.close()
    }
    const child = this.child
    this.child = null
    if (child !== null && child.exitCode === null) {
      const deadline = Date.now() + 4000
      while (Date.now() < deadline && child.exitCode === null) await sleep(200)
      if (child.exitCode === null) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } catch {
          try { child.kill() } catch {}
        }
        await sleep(1000)
      }
    }
    rmSync(join(this.opts.profileDir, 'DevToolsActivePort'), { force: true })
  }
}
