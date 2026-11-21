// 验证 loadRemoteModules 的两条取数路径：
//   1. 新版 dsh-remote（带 lib/deck-bridge.js）→ 走公开入口；
//   2. 老版 dsh-remote（无公开入口）→ 回退到三个内部模块。
// 用临时假包 + DSH_DECK_REMOTE_PKG 指过去，不依赖真实 dsh-remote。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { loadRemoteModules } = await import('../lib/services.js')

function makePkg(withBridge) {
  const root = mkdtempSync(path.join(tmpdir(), 'fake-dsh-remote-'))
  const lib = path.join(root, 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(path.join(root, 'package.json'), '{"name":"dsh-remote","version":"9.9.9"}')
  const marker = (name) => `export const ${name} = () => '${name}'\n`
  writeFileSync(path.join(lib, 'binding.js'), marker('resolveMirror'))
  writeFileSync(path.join(lib, 'openssh.js'), 'export class SystemOpenSshPool {}\n')
  writeFileSync(path.join(lib, 'paths.js'),
    marker('resolveRemoteWorkspacePath') + marker('relPathUnder') + marker('remoteDirname') + marker('shq'))
  if (withBridge) {
    writeFileSync(path.join(lib, 'deck-bridge.js'),
      "export { resolveMirror } from './binding.js'\n" +
      "export { SystemOpenSshPool } from './openssh.js'\n" +
      "export { resolveRemoteWorkspacePath, relPathUnder, remoteDirname, shq } from './paths.js'\n")
  }
  return root
}

test('新版 dsh-remote：从公开入口取到全部能力', async () => {
  const root = makePkg(true)
  process.env.DSH_DECK_REMOTE_PKG = path.join(root, 'package.json')
  try {
    const mods = await loadRemoteModules()
    assert.equal(mods.root, root)
    assert.equal(typeof mods.binding.resolveMirror, 'function')
    assert.equal(typeof mods.openssh.SystemOpenSshPool, 'function')
    for (const k of ['resolveRemoteWorkspacePath', 'relPathUnder', 'remoteDirname', 'shq']) {
      assert.equal(typeof mods.paths[k], 'function', k)
    }
    assert.equal(mods.binding.resolveMirror(), 'resolveMirror')
  } finally { delete process.env.DSH_DECK_REMOTE_PKG; rmSync(root, { recursive: true, force: true }) }
})

test('老版 dsh-remote：无公开入口时回退到内部模块', async () => {
  const root = makePkg(false)
  process.env.DSH_DECK_REMOTE_PKG = path.join(root, 'package.json')
  try {
    const mods = await loadRemoteModules()
    assert.equal(mods.root, root)
    assert.equal(typeof mods.binding.resolveMirror, 'function')
    assert.equal(typeof mods.openssh.SystemOpenSshPool, 'function')
    assert.equal(mods.paths.relPathUnder(), 'relPathUnder')
  } finally { delete process.env.DSH_DECK_REMOTE_PKG; rmSync(root, { recursive: true, force: true }) }
})
