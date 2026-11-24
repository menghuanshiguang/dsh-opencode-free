// 把「档案必须绑在这一条 run 的 live 产物上」这道闸门接进 CI。
//
// 为什么不加 workflow 步骤：`.github/workflows/` 在阶段 5 的保护集里，动它就得按跑道规矩重验，
// 而 `npm test` 本来就跑 `scripts/tests/*.test.mjs`——闸门在这里被跑到，等于已经接线。
//
// 判据只有一条：node gates/check-artifact-binding.mjs 退出 0。它自己那五档（列表分支挑件、
// 只剩封存 zip、两件同名、封存在线挑件、封存在线只剩封存 zip）已经在脚本里逐档打印。
// exit 2 是「本机判不了」（缺真 curl/unzip 时的自述），在这里同样算失败：不可判不许当通过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')

test('archive is bound to this run\'s live artifact, never the seal zip', () => {
  const r = spawnSync(process.execPath, ['gates/check-artifact-binding.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  assert.equal(r.status, 0, `gates/check-artifact-binding.mjs exit ${r.status}（2 = 本机判不了，也不是通过）:\n${out}`)
})
