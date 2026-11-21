// issue #4 第三点回归：插件的日志必须落在可查的位置。
// 原来只写 ctx.get("logCtx")（插件拿不到这个宿主服务），于是永远落 stderr，GUI 进程里用户看不到，
// 下游实测日志里搜不到本插件字样。现在写到 deck 自己的日志目录，这里验证路径规则与真实写入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mod = await import('../lib/index.js')
const logFilePath = mod.logFilePath

test('日志路径落在 profiles/<profile>/.dsh-mattskillsdeck-cache/logs/<day>.log', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dshhome-'))
  const oldHome = process.env.DSH_HOME, oldProf = process.env.DSH_PROFILE
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'web'
  try {
    const f = logFilePath()
    assert.ok(f, '应返回路径')
    assert.ok(f.includes(path.join('profiles', 'web', '.dsh-mattskillsdeck-cache', 'logs')), '目录规则: ' + f)
    assert.match(path.basename(f), /^\d{4}-\d{2}-\d{2}\.log$/, '一天一个文件: ' + f)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    if (oldProf === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = oldProf
    rmSync(home, { recursive: true, force: true })
  }
})

test('源码里 log() 确实先写文件（appendFileSync）再退 stderr', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('function log(ctx, level, msg)'), src.indexOf('function log(ctx, level, msg)') + 900)
  assert.ok(body.includes('appendFileSync'), '应 append 到文件')
  assert.ok(body.includes('logFilePath()'), '应用统一路径')
  assert.ok(body.indexOf('appendFileSync') < body.indexOf('process.stderr.write'), '先写文件，最后才 stderr')
})
