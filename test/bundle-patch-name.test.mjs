// bundle patch 的 name 必须是完整包名（对照 @dougen/@mengyuly 等同仓先例）。
// 包名 scope 化之后，若 name 仍写 'dsh-remote'，DSH 按该名解析模块会 MODULE_NOT_FOUND，
// 插件整体加载失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

test('dsh-remote 的 cordis.patch.yml name 用完整包名', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'dsh-remote')
  const yml = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const m = yml.match(/name:\s*'([^']+)'/)
  assert.ok(m, 'patch 应声明 name')
  assert.equal(m[1], pkg.name, 'patch 的 name 必须等于 package.json 的 name')
})
