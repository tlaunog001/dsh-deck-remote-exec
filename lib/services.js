// services.js — 为 deck 提供 remoteFs / remoteExec 服务。
//
// 为什么单独实现而不是改 dsh-remote：
//   dsh-remote 升级会覆盖 lib/*.js，任何写进它源码的补丁都会丢。
//   本插件在启动时用「绝对路径动态 import」读 dsh-remote 的纯能力
//   （resolveMirror / SystemOpenSshPool / paths），不改它一个字节。
//
// 复用而非重写：
//   - 镜像识别 → dsh-remote/lib/binding.js 的 resolveMirror（纯函数）
//   - 远端连接 → dsh-remote/lib/openssh.js 的 SystemOpenSshPool（既有实现）
//   - 路径翻译 → dsh-remote/lib/paths.js（同一套语义）

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'

const DEP_PKG = 'dsh-remote'

export async function loadRemoteModules() {
  // 解析顺序：
  //   1. 本插件自己的依赖链（发布版可能把 dsh-remote 列为 peer）
  //   2. DSH profile 的 node_modules（插件与 dsh-remote 同装一处）
  //   3. 显式环境变量 DSH_DECK_REMOTE_PKG
  const req = createRequire(import.meta.url)
  const candidates = []
  if (process.env.DSH_DECK_REMOTE_PKG) candidates.push(process.env.DSH_DECK_REMOTE_PKG)
  try { candidates.push(req.resolve(DEP_PKG + '/package.json')) } catch {}
  try {
    const pluginDir = path.dirname(path.dirname(new URL(import.meta.url).pathname))
    candidates.push(path.join(path.dirname(pluginDir), DEP_PKG, 'package.json'))
  } catch {}
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const prof = process.env.DSH_PROFILE || 'desktop'
    candidates.push(path.join(dshHome, 'profiles', prof, 'node_modules', DEP_PKG, 'package.json'))
  } catch {}
  let pkgPath = null
  for (const c of candidates) { if (c && existsSync(c)) { pkgPath = c; break } }
  if (!pkgPath) return null
  const root = path.dirname(pkgPath)
  const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)
  const [binding, openssh, paths] = await Promise.all([
    load('lib/binding.js'),
    load('lib/openssh.js'),
    load('lib/paths.js'),
  ])
  return { root, binding, openssh, paths }
}

/** dsh 的远端镜像根目录。 */
export function remoteWorkspacesRoot() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'remote-workspaces')
}

function readMeta(mirrorDir) {
  try {
    const j = JSON.parse(readFileSync(path.join(mirrorDir, '.dsh-remote-meta.json'), 'utf8'))
    if (j && j.host && j.remotePath) return j
  } catch {}
  return null
}

/**
 * 远端命令返回的是 /mnt/data/xxx 这种远端路径，它不在镜像前缀下，
 * 但仍是这个会话的远端。按最长前缀反查镜像。
 */
function locateByRemoteRoot(root, p) {
  if (typeof p !== 'string' || p.charAt(0) !== '/') return null
  let hostDirs = []
  try { hostDirs = readdirSync(root) } catch { return null }
  let best = null
  for (const hostDir of hostDirs) {
    const hostPath = path.join(root, hostDir)
    let names = []
    try { names = readdirSync(hostPath) } catch { continue }
    for (const name of names) {
      const mirrorDir = path.join(hostPath, name)
      const meta = readMeta(mirrorDir)
      if (!meta) continue
      const r = String(meta.remotePath).replace(/\/+$/, '')
      // 三种情况都算「这个镜像负责的远端路径」：
      //   1. 就是它自己
      //   2. 在它下面（子孙）
      //   3. 是它的祖先 —— 工作区选在仓库子目录里时，git rev-parse --show-toplevel
      //      会返回上层目录（例如工作区 /data/models/vllm，仓库根却是 /data/models）。
      //      这时命令仍应在镜像自己的工作区里跑，所以 ws 保持 r 不变。
      const isSelfOrChild = p === r || p.indexOf(r + '/') === 0
      // 祖先只认「紧邻的上层」（最多上溯到根，避免 /data 这种过宽匹配把整台机器都算进来）
      const depth = (s) => s.split('/').filter(Boolean).length
      const isAncestor = r.indexOf(p + '/') === 0 && depth(p) >= depth(r) - 1
      if (!isSelfOrChild && !isAncestor) continue
      // 自身/子孙优先于祖先，其次取最长匹配
      if (!best || (isSelfOrChild && !best.selfOrChild) || (isSelfOrChild === best.selfOrChild && r.length > best.ws.length)) {
        best = { ws: r, mirrorDir, meta, selfOrChild: isSelfOrChild }
      }
    }
  }
  return best
}

export async function createServices(mods) {
  if (!mods) return null
  const { binding, openssh, paths } = mods
  const root = remoteWorkspacesRoot()
  const pools = new Map()

  function poolFor(meta) {
    const host = meta.alias || meta.host
    const key = [host, meta.port || 22, meta.username || ''].join('|')
    if (pools.has(key)) return pools.get(key)
    let pool = null
    try {
      pool = new openssh.SystemOpenSshPool({
        host,
        port: Number(meta.port) || 22,
        username: meta.username || '',
        workspace: meta.remotePath,
        backend: 'openssh',
        sshBinary: 'ssh',
        commandTimeoutMs: 20000,
        hostKeyMode: '',
        maxOutputChars: 64 * 1024,
      }, {})
    } catch { pool = null }
    if (pool) pools.set(key, pool)
    return pool
  }

  function locate(p) {
    if (typeof p !== 'string' || !p) return null
    let hit = null
    try { hit = binding.resolveMirror(p, root) } catch {}
    if (hit && hit.mirrorDir && hit.machine && hit.remotePath) {
      const pool = poolFor({ ...hit.machine, remotePath: hit.remotePath })
      if (pool) return { ws: hit.remotePath, mirrorDir: hit.mirrorDir, pool }
    }
    const byRoot = locateByRemoteRoot(root, p)
    if (byRoot) {
      const pool = poolFor({ ...byRoot.meta, remotePath: byRoot.ws })
      if (pool) return { ws: byRoot.ws, mirrorDir: byRoot.mirrorDir, pool }
    }
    return null
  }

  const toRemote = (loc, raw) => paths.resolveRemoteWorkspacePath(loc.ws, raw, loc.mirrorDir)
  const rawOf = (v) => (typeof v === 'string' ? v : (v && (v.displayPath || v.targetKey)) || '')
  const inside = (target, wsRoot) => { try { return paths.relPathUnder(wsRoot, target) !== null } catch { return false } }
  const denied = () => Object.assign(new Error('[sandbox: workspace-write]\nremote write outside the workspace'), { code: 'FS_SANDBOX_DENIED' })

  const mkTarget = (remotePath, display) => ({ targetKey: display || remotePath, displayPath: display || remotePath, remotePath, remote: true })

  /** 把任意入参（字符串路径 / target 对象）统一成 { loc, remotePath }。 */
  function resolveArg(v) {
    const t = v && typeof v === "object" && v.remote ? v : null;
    if (t) {
      const loc = locate(t.displayPath) || locate(t.targetKey)
      if (loc) return { loc, remotePath: t.remotePath }
      return null
    }
    const raw = rawOf(v)
    if (!raw) return null
    const loc = locate(raw)
    if (!loc) return null
    return { loc, remotePath: toRemote(loc, raw) }
  }

  async function sftpOf(loc) {
    if (typeof loc.pool.detect === 'function') { try { await loc.pool.detect() } catch {} }
    return loc.pool.sftp()
  }

  function locOf(v) {
    const t = v && v.remote ? v : null
    if (t) return locate(t.displayPath) || locate(t.targetKey)
    return locate(rawOf(v))
  }

  async function mkdirChain(sftp, dir) {
    if (!dir) return
    let cur = ''
    for (const seg of String(dir).split('/').filter(Boolean)) { cur += '/' + seg; try { await sftp.mkdir(cur) } catch {} }
  }

  const fsFacade = {
    async resolve(p, opts) {
      const raw = rawOf(p)
      // deck 常用相对路径 + { cwd }（如 resolve("docs/agents/workspace.yaml", { cwd })）。
      // 相对路径自身定位不到镜像，要先按 cwd 锚定。
      const baseCwd = (opts && opts.cwd) || ""
      const abs = raw && raw.charAt(0) === '/' ? raw : (baseCwd ? path.posix.join(baseCwd, raw) : raw)
      const loc = locate(abs) || locate(baseCwd)
      if (!loc) return null
      return mkTarget(toRemote(loc, abs), abs)
    },
    async readText(v) {
      const a = resolveArg(v); if (!a) return null
      const sftp = await sftpOf(a.loc)
      return (await sftp.readFile(a.remotePath)).toString('utf8')
    },
    async listDir(v) {
      const a = resolveArg(v); if (!a) return null
      const sftp = await sftpOf(a.loc)
      return (await sftp.readdir(a.remotePath)).map((e) => e.filename || e.name || String(e))
    },
    async readdir(v) {
      const a = resolveArg(v); if (!a) return null
      const sftp = await sftpOf(a.loc)
      return (await sftp.readdir(a.remotePath)).map((e) => e.filename || e.name || String(e))
    },
    async stat(v) {
      const a = resolveArg(v); if (!a) return null
      const sftp = await sftpOf(a.loc)
      return sftp.stat(a.remotePath)
    },
    async lstat(v) {
      const a = resolveArg(v); if (!a) return null
      const sftp = await sftpOf(a.loc)
      try { return await sftp.lstat(a.remotePath) } catch { return sftp.stat(a.remotePath) }
    },
    async exists(v) {
      const a = resolveArg(v); if (!a) return false
      const sftp = await sftpOf(a.loc)
      try { await sftp.stat(a.remotePath); return true } catch { return false }
    },
    async writeText(v, content) {
      const a = resolveArg(v); if (!a) return null
      if (!inside(a.remotePath, a.loc.ws)) throw denied()
      const sftp = await sftpOf(a.loc)
      await mkdirChain(sftp, paths.remoteDirname(a.remotePath))
      await sftp.writeFile(a.remotePath, Buffer.from(String(content), 'utf8'))
    },
    async mkdir(v) {
      const a = resolveArg(v); if (!a) return null
      if (!inside(a.remotePath, a.loc.ws)) throw denied()
      const sftp = await sftpOf(a.loc)
      await mkdirChain(sftp, a.remotePath)
    },
    async rename(from, to) {
      const a = resolveArg(from); if (!a) return null
      const rawTo = rawOf(to)
      const loc = a.loc
      const rt = (to && typeof to === "object" && to.remotePath) ? to.remotePath : toRemote(loc, rawTo)
      if (!inside(rt, loc.ws)) throw denied()
      const sftp = await sftpOf(loc)
      await mkdirChain(sftp, paths.remoteDirname(rt))
      if (typeof sftp.renameOverwrite === 'function') return sftp.renameOverwrite(a.remotePath, rt)
      return sftp.rename(a.remotePath, rt)
    },
    async unlink(v) {
      const a = resolveArg(v); if (!a) return null
      if (!inside(a.remotePath, a.loc.ws)) throw denied()
      const sftp = await sftpOf(a.loc)
      return sftp.unlink(a.remotePath)
    },
    async rm(v) {
      const a = resolveArg(v); if (!a) return null
      if (!inside(a.remotePath, a.loc.ws)) throw denied()
      const sftp = await sftpOf(a.loc)
      try { await sftp.unlink(a.remotePath) } catch { try { await sftp.rmdir(a.remotePath) } catch {} }
    },
  }

  const q = (s) => paths.shq(String(s))

  async function runExec(cmd, argvOrOpts, opts) {
    let argv = null
    let o = {}
    if (Array.isArray(argvOrOpts)) { argv = [String(cmd)].concat(argvOrOpts.map(String)); o = (opts && typeof opts === 'object') ? opts : {} }
    else { o = (argvOrOpts && typeof argvOrOpts === 'object') ? argvOrOpts : (opts || {}) }
    const cwd = o.cwd || ''
    const loc = locate(cwd)
    if (!loc) return { stdout: '', stderr: 'not a remote workspace: ' + cwd, code: -1, text: '', ok: false, error: 'NOT_REMOTE' }
    const remoteCwd = toRemote(loc, cwd || loc.ws)
    // 参数里也可能带镜像路径（典型：git -C <mirror>）。
    // 远端不存在这些本地路径，必须以字符串替换成对应的远端路径，否则命令必失败（git 报 128）。
    // BUG-008：只翻译「确实落在本地镜像内的绝对路径」（典型：git -C <mirror>/...）。
    //   原逻辑把所有含 '/' 的参数都当路径翻译，导致 gh api 的端点
    //   'repos/<owner>/<repo>' 被拼成 '<ws>/repos/<owner>/<repo>'，GitHub 回 404；
    //   jq 表达式 '.nameWithOwner' 等也被误伤。相对端点/查询串一律原样透传。
    const xlate = (a) => {
      if (typeof a !== 'string' || a.indexOf('/') < 0) return a
      // 只有以 '/' 或 Windows 盘符开头的绝对路径才可能是本地镜像路径
      if (!(a.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(a))) return a
      try {
        if (paths.relPathUnder(loc.mirrorDir, a) === null) return a
        return toRemote(loc, a)
      } catch { return a }
    }
    const command = argv ? argv.map((a, i) => (i === 0 ? a : q(xlate(a)))).join(' ') : String(cmd)
    const pool = loc.pool
    if (pool.config && !Number.isFinite(Number(pool.config.maxOutputChars))) pool.config.maxOutputChars = 64 * 1024
    try {
      if (typeof pool.detect === 'function') await pool.detect()
      const wrapped = 'export PATH="$HOME/.local/bin:$HOME/bin:$PATH"; cd ' + q(remoteCwd) + ' && ' + command
      const r = await pool.exec(wrapped, { timeoutMs: Number(o.timeout) >= 0 ? Number(o.timeout) : 20000, signal: o.signal })
      const stdout = String((r && r.stdout) || '')
      const stderr = String((r && r.stderr) || '')
      const code = r && typeof r.code === 'number' ? r.code : -1
      return { stdout, stderr, code, text: stdout, ok: code === 0 }
    } catch (e) {
      const msg = String((e && e.message) || e)
      return { stdout: '', stderr: msg, code: -1, text: '', ok: false, error: msg }
    }
  }

  const execFacade = {
    exec: runExec,
    async resolveExecutable(name, opts) {
      const cwd = (opts && opts.cwd) || ''
      const r = await runExec('command -v ' + q(name), { cwd, timeout: (opts && opts.timeout) || 5000 })
      if (r.code !== 0) return null
      const first = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0]
      return first || null
    },
    isRemotePath: (p) => locate(p) !== null,
  }

  return {
    fsService: { apiVersion: 1, fs: fsFacade, locate, toRemote, isRemotePath: (p) => locate(p) !== null },
    execService: { apiVersion: 1, ...execFacade },
    dispose() { for (const [, p] of pools) { try { p.close() } catch {} } pools.clear() },
  }
}