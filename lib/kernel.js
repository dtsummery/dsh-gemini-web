/**
 * gemini-web2api-go 内核托管层。
 *
 * 职责：定位（必要时下载）单文件内核，启动/守护进程，并封装它的 admin REST
 * （Cookie 池、代理池、API key、连通性诊断）。本模块不依赖 DSH 的任何接口，
 * 可以独立测试。
 */
import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, chmodSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

/** 内核默认固定在这个版本；升级只改这一处。 */
export const KERNEL_VERSION = 'v4.20.0'

/** 平台对应的 release 资产名。 */
export function kernelAssetName(version = KERNEL_VERSION) {
  const plat = process.platform
  const arch = process.arch
  const suffix = plat === 'win32' ? '.exe' : ''
  const osName = plat === 'win32' ? 'windows' : plat === 'darwin' ? 'darwin' : 'linux'
  const archName = arch === 'arm64' ? 'arm64' : 'amd64'
  return `gemini-web2api-go_${version}_${osName}_${archName}${suffix}`
}

export function kernelDownloadUrl(version = KERNEL_VERSION, asset = kernelAssetName(version)) {
  return `https://github.com/zexadev/gemini-web2api-go/releases/download/${version}/${asset}`
}

/** 选一个空闲的本地端口（避免与手工起的实例或其他软件撞车）。 */
export function findFreePort(preferred) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => {
      const srv2 = createServer()
      srv2.once('error', () => resolve(0))
      srv2.listen(0, '127.0.0.1', () => {
        const p = srv2.address().port
        srv2.close(() => resolve(p))
      })
    })
    srv.once('listening', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
    srv.listen(preferred ?? 0, '127.0.0.1')
  })
}

async function fetchWithOptionalProxy(url, proxyUrl) {
  if (!proxyUrl) return fetch(url)
  try {
    const { ProxyAgent } = await import('undici')
    return fetch(url, { dispatcher: new ProxyAgent(proxyUrl) })
  } catch {
    // 没有 undici 时退回直连，失败由调用方报告
    return fetch(url)
  }
}

/**
 * 下载内核二进制到目标路径（先写 .part 再改名，避免半成品被当成可用内核）。
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function downloadKernel(destPath, { version = KERNEL_VERSION, proxyUrl = '' } = {}) {
  const url = kernelDownloadUrl(version)
  const partPath = `${destPath}.part`
  mkdirSync(join(destPath, '..'), { recursive: true })
  const res = await fetchWithOptionalProxy(url, proxyUrl)
  if (!res.ok) throw new Error(`下载内核失败：HTTP ${res.status}（${url}）`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const out = createWriteStream(partPath)
  let bytes = 0
  for await (const chunk of res.body) {
    bytes += chunk.length
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  try {
    rmSync(destPath, { force: true })
    renameSync(partPath, destPath)
  } catch (error) {
    // 目标 exe 被正在运行的内核占用时，Windows 会直接拒绝删除/覆盖（EPERM）。
    rmSync(partPath, { force: true })
    throw new Error(`替换内核失败（${error?.code ?? '未知错误'}）：目标文件正被占用。请先点「重启内核」停掉内核，或确认没有别处运行着 gemini-web2api-go`)
  }
  try { chmodSync(destPath, 0o755) } catch {}
  return { path: destPath, bytes, expected: total }
}

/** 内核进程 + admin REST 客户端。 */
export class Kernel {
  /**
   * @param {{binPath: string, port: number, dbPath: string, adminToken: string, apiKey: string, proxyUrl?: string, extraArgs?: string[], onLog?: (line: string) => void}} opts
   */
  constructor(opts) {
    this.opts = opts
    this.child = null
    /** 端口上是别人（如上次退出后残留）起的实例：本对象不持有子进程，但内核确实可用。 */
    this.adopted = false
    this.base = `http://127.0.0.1:${opts.port}`
  }

  get apiBaseUrl() {
    return `${this.base}/v1`
  }

  async health() {
    try {
      const res = await fetch(`${this.base}/`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return undefined
      return await res.json()
    } catch {
      return undefined
    }
  }

  /** 启动内核；若端口上已经有健康实例则直接复用，不重复起进程。 */
  async start() {
    const alive = await this.health()
    if (alive) {
      // 复用不持有子进程，但 running 必须为 true：否则 Cookie 自愈守护会整段失效。
      this.adopted = true
      return { reused: true, banner: alive }
    }
    this.adopted = false

    const { binPath, port, dbPath, adminToken, apiKey, proxyUrl, extraArgs = [], onLog } = this.opts
    if (!binPath || !existsSync(binPath)) throw new Error(`内核不存在：${binPath}`)
    mkdirSync(join(dbPath, '..'), { recursive: true })

    const args = [
      '--port', String(port),
      '--db', dbPath,
      '--admin-token', adminToken,
      '--api-key', apiKey,
      ...(proxyUrl ? ['--proxy', proxyUrl] : []),
      ...extraArgs
    ]
    this.child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const pipe = (stream, tag) => {
      let buf = ''
      stream?.on('data', (d) => {
        buf += d.toString()
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onLog?.(`[${tag}] ${line}`)
      })
    }
    pipe(this.child.stdout, 'kernel')
    pipe(this.child.stderr, 'kernel:err')
    this.child.on('exit', (code) => onLog?.(`[kernel] exited code=${code}`))

    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const h = await this.health()
      if (h) return { reused: false, banner: h }
      await new Promise((r) => setTimeout(r, 400))
    }
    throw new Error('内核启动超时（20s 内 / 未就绪）')
  }

  async stop() {
    this.adopted = false
    if (!this.child) return false
    try { this.child.kill() } catch {}
    this.child = null
    return true
  }

  /**
   * 结束实例：托管实例直接结束子进程；复用来的残留实例按监听端口反查 PID 再结束。
   *
   * 更新内核二进制之前必须先调它 —— Windows 下正在运行的 exe 被进程占用，
   * 覆盖或删除都会 EPERM。
   * @returns {Promise<boolean>}
   */
  async shutdown() {
    if (this.child) {
      try { this.child.kill() } catch {}
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && this.child && this.child.exitCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      this.child = null
    } else if (this.adopted) {
      await this.killByPort()
    }
    this.adopted = false
    return true
  }

  /**
   * 重启内核：先结束实例，再重新拉起。
   * @returns {Promise<{reused: boolean, banner: any}>}
   */
  async restart() {
    await this.shutdown()
    return this.start()
  }

  /** 按监听端口反查 PID 并结束进程（只用于接管残留内核）。 */
  async killByPort() {
    if (process.platform !== 'win32') return false
    const stdout = await new Promise((resolve) => {
      execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 15000 }, (_error, out) => resolve(String(out ?? '')))
    })
    const pattern = new RegExp(`[:.]${this.opts.port}\\s`)
    const line = stdout.split(/\r?\n/).find((row) => /LISTENING/i.test(row) && pattern.test(row))
    const pid = line?.trim().split(/\s+/).pop()
    if (!pid || !/^\d+$/.test(pid)) return false
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true, timeout: 15000 }, () => resolve(undefined))
    })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return true
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null) || this.adopted === true
  }

  /** admin REST 调用（Bearer adminToken）。 */
  async admin(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${this.base}/admin/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.adminToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = { raw: text } }
    if (!res.ok) throw new Error(`admin ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`)
    return json
  }

  listCookies() { return this.admin('/cookies') }
  addCookie(label, cookie, note = '') { return this.admin('/cookies', { method: 'POST', body: { label, cookie, note } }) }
  deleteCookie(id) { return this.admin(`/cookies/${id}`, { method: 'DELETE' }) }
  checkCookie(id) { return this.admin(`/cookies/${id}/check`, { method: 'POST' }) }
  rotateCookie(id) { return this.admin(`/cookies/${id}/rotate`, { method: 'POST' }) }
  toggleCookie(id) { return this.admin(`/cookies/${id}/toggle`, { method: 'POST' }) }
  listProxies() { return this.admin('/proxies') }
  addProxy(name, url) { return this.admin('/proxies', { method: 'POST', body: { name, url } }) }
  availableModels() { return this.admin('/config') }
  test(prompt = 'Reply with one short word.', proxyId) {
    const q = new URLSearchParams({ prompt })
    if (proxyId !== undefined) q.set('proxy_id', String(proxyId))
    return this.admin(`/test?${q.toString()}`)
  }

  /** 读取内核当前模型清单（用于 DSH 侧模型开关默认值）。 */
  async models() {
    const res = await fetch(`${this.base}/v1/models`, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return []
    const json = await res.json()
    return (json.data ?? []).map((m) => m.id)
  }
}

/** 读取 .env.local 风格的键值文件。 */
export function readKeyValueFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** 覆写 .env.local 风格的键值文件。 */
export function writeKeyValueFile(path, kv) {
  mkdirSync(join(path, '..'), { recursive: true })
  const body = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  writeFileSync(path, body, 'utf8')
}
