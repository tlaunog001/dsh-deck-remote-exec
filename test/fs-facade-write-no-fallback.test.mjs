// issue #7 回归：写操作在远端镜像路径下失败时，绝不能静默回落到本地。
//
// 事故形态：deck 写文件走 writeTextFile 的三条退路（resolve+writeText / writeFile / writeText），
//   远端 facade 对「定位不到的目标」一律返回 null，而 facade 的规则是「远端没结果就回落本地」。
//   于是同一个开票动作，一部分文件写进远端镜像、一部分写进本地 git 仓库，且没有任何日志。
//
// 修法两条：① 写方法 + 路径在镜像里 + 远端没写成 → 抛错（RDE_REMOTE_WRITE_FAILED），不回落；
//          ② 回落要发声（fs.fallback，写方法记 warn）；③ 补上远端 writeFile，让第二条退路可用。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { patchSource } = await import('../lib/index.js')

const fakeDeck = `export default {\n  name: 'fake',\n  apply(ctx) {\n    const x = 1;\n  }\n}\n`

function buildFacade(opts = {}) {
  const patched = patchSource(fakeDeck)
  assert.notEqual(patched, fakeDeck, 'patch 必须打上')
  const iStart = patched.indexOf('const __rdeLocalFs = ctx.get("fs");')
  const iEnd = patched.indexOf('const __rdeBaseGet')
  assert.ok(iStart > 0 && iEnd > iStart, '应能取出注入块')
  const block = patched.slice(iStart, iEnd)

  const localCalls = []
  const logged = []
  const localFs = {
    writeText: async (p) => { localCalls.push(['writeText', p]) },
    writeFile: async (p) => { localCalls.push(['writeFile', p]) },
    readText: async () => { localCalls.push(['readText']); return 'LOCAL' },
  }
  const MIRROR = '/home/u/.dsh/remote-workspaces/h-u-22/models'
  const remoteFs = {
    writeText: async () => null,
    writeFile: opts.remoteWriteFile === 'absent' ? undefined : (async () => null),
    readText: async () => null,
  }
  const services = {
    'fs': localFs,
    'remoteFs': { fs: remoteFs, isRemotePath: (p) => String(p).includes('remote-workspaces') },
    'logCtx': { fire: (lvl, ev, f) => logged.push({ lvl, ev, f }), isEnabled: () => true },
  }
  const ctx = { get: (k) => services[k] }
  // 签名带版本戳（issue #8）：从产物块里取实际注入的 facade 变量名。
  const facadeName = (block.match(/const (__rdeFsFacade\w*) = new Proxy/) || [])[1] || '__rdeFsFacade'
  const facade = new Function('ctx', block + '\n return ' + facadeName + ';')(ctx)
  return { facade, localCalls, logged, MIRROR }
}

test('#7 镜像内写失败 → 抛错且不写本地（不再静默分裂）', async () => {
  const { facade, localCalls, MIRROR } = buildFacade()
  await assert.rejects(
    () => facade.writeText(MIRROR + '/docs/a.md', 'x'),
    (e) => e && e.code === 'RDE_REMOTE_WRITE_FAILED' && /拒绝回落/.test(e.message),
  )
  assert.equal(localCalls.length, 0, '本地必须一次都没被调用，实际: ' + JSON.stringify(localCalls))
})

test('#7 writeFile 同样受保护（deck 的第二条退路）', async () => {
  const { facade, localCalls, MIRROR } = buildFacade()
  await assert.rejects(
    () => facade.writeFile(MIRROR + '/docs/a.md', 'x'),
    (e) => e && e.code === 'RDE_REMOTE_WRITE_FAILED',
  )
  assert.equal(localCalls.length, 0, '本地必须一次都没被调用')
})

test('#7 镜像内读允许回落本地（读回落无害）', async () => {
  const { facade, localCalls, MIRROR } = buildFacade()
  const r = await facade.readText(MIRROR + '/docs/a.md')
  assert.equal(r, 'LOCAL')
  assert.ok(localCalls.length > 0, '读应回落本地')
})

test('#7 非镜像路径的写仍回落本地（不误伤普通目录）', async () => {
  const { facade, localCalls } = buildFacade()
  await facade.writeText('/home/u/normal-project/a.md', 'x')
  assert.ok(localCalls.length > 0, '不在镜像内的写应正常回落')
})

test('#7 回落必须发声（写方法记 warn，带 method/isWrite/why）', async () => {
  const { facade, logged, MIRROR } = buildFacade()
  // 非镜像路径走回落，会记一条
  await facade.writeText('/home/u/normal-project/a.md', 'x')
  const hit = logged.find((x) => x.ev === 'fs.fallback')
  assert.ok(hit, '应记 fs.fallback，实际: ' + JSON.stringify(logged))
  assert.equal(hit.lvl, 'warn', '写方法的回落应是 warn 级')
  assert.equal(hit.f.method, 'writeText')
  assert.equal(hit.f.isWrite, true)
  assert.ok(hit.f.why, '应带原因')
})

test('#7 远端 fs 必须实现 writeFile（否则 deck 第二条退路永远失效）', async () => {
  const services = await import('../lib/services.js')
  // createServices 需要 mods；直接检查源码里有没有这个实现更稳
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/services.js', import.meta.url), 'utf8')
  assert.ok(/async writeFile\(v, data\)/.test(src), '远端 fsFacade 应有 writeFile')
})
