// 双包名兼容回归：修好的 dsh-remote 只能发到自己的 scope（@tlaunog001/dsh-remote），
// 官方的 `dsh-remote` 仍在。RDE 必须两个都能认，否则换包名后远端能力直接失联。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../lib/services.js', import.meta.url), 'utf8')

test('候选包名同时包含官方名与本人 scope 名', () => {
  const m = SRC.match(/DEP_PKG_CANDIDATES\s*=\s*\[([^\]]+)\]/)
  assert.ok(m, '应声明 DEP_PKG_CANDIDATES')
  assert.ok(m[1].includes("'dsh-remote'"), '必须仍认官方包名')
  assert.ok(m[1].includes("'@tanker001/dsh-remote'"), '必须认本人 scope 包名')
})

test('三个解析位置（require / 同级目录 / profile）都对每个包名各探一次', () => {
  assert.ok(/for \(const pkg of DEP_PKG_CANDIDATES\)/.test(SRC), '解析应遍历候选包名')
  assert.ok(/req\.resolve\(pkg \+ '\/package\.json'\)/.test(SRC), 'require 解析应带包名变量')
  assert.ok(/profiles', prof, 'node_modules', pkg/.test(SRC), 'profile 解析应带包名变量')
})

test('环境变量 DSH_DECK_REMOTE_PKG 仍最高优先', () => {
  const iEnv = SRC.indexOf('process.env.DSH_DECK_REMOTE_PKG')
  const iLoop = SRC.indexOf('for (const pkg of DEP_PKG_CANDIDATES)')
  assert.ok(iEnv > 0 && iLoop > iEnv, '显式环境变量应先于候选遍历被采用')
})
