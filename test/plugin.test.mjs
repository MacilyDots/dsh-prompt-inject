/* dsh-prompt-inject 回归测试。
 *
 * 用真实的 @deepseek-ai/cordis + @deepseek-ai/dsh-system-prompt 跑完整 assembly，
 * 验证插件在「complete: true 段」场景下的行为，以及各种配置闸门。
 *
 * 运行前需要能解析到那两个包，按以下顺序找：
 *   1. 环境变量 DSH_MODULES 指向的目录（里面应有 @deepseek-ai/）
 *   2. <DSH_HOME>/profiles/node_modules（DSH_HOME 默认 ~/.dsh）
 *
 * 用法: node test/plugin.test.mjs
 */

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ENTRY = path.join(HERE, '..', 'lib', 'index.js')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const MODULES = process.env.DSH_MODULES || path.join(DSH_HOME, 'profiles', 'node_modules')

if (!fs.existsSync(path.join(MODULES, '@deepseek-ai'))) {
  console.error(`找不到 @deepseek-ai/，请设置 DSH_MODULES 指向含它的 node_modules 目录。`)
  console.error(`当前尝试: ${MODULES}`)
  process.exit(2)
}

const req = createRequire(path.join(MODULES, 'noop.js'))
const load = async (s) => import(pathToFileURL(req.resolve(s)).href)

const { Context } = await load('@deepseek-ai/cordis')
const { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const plugin = await import(pathToFileURL(PLUGIN_ENTRY).href)

let pass = 0
let fail = 0
const t = (name, got, want) => {
  const ok = got === want
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
  if (!ok) {
    console.log(`      期望: ${JSON.stringify(want)}`)
    console.log(`      实际: ${JSON.stringify(got)}`)
  }
}

/* 每个用例都新起一个 Context；await ctx.plugin() 是必须的 ——
   cordis 的 apply 在后续微任务里执行，不 await 会读到尚未注册的变量表。 */
async function run(cfg, context) {
  const ctx = new Context()
  ctx.plugin(SystemPrompt, {})
  if (!ctx.systemPrompt) new SystemPrompt(ctx, {})
  await ctx.plugin(plugin, cfg)
  ctx.systemPrompt.section({ name: 'persona', order: 999, text: 'PRE|{{inject}}|POST', complete: true })
  return renderPrompt(await ctx.systemPrompt.assemble(context))
}

const ctxOf = (preset, cwd = '/work', sid = 's1') => ({
  agent: { session: { id: sid, header: { agentPreset: preset, cwd } } },
})

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-inject-'))
const tf = path.join(tmp, 'text.txt')
fs.writeFileSync(tf, 'FROM-FILE', 'utf8')
const sf = path.join(tmp, 'state.json')
fs.writeFileSync(sf, JSON.stringify({ enabled: false }), 'utf8')

t('基本注入', await run({ text: 'INJ' }, ctxOf('any')), 'PRE|INJ|POST')
t('preset 白名单命中', await run({ text: 'INJ', presets: ['my-preset'] }, ctxOf('my-preset')), 'PRE|INJ|POST')
t('preset 白名单未命中', await run({ text: 'INJ', presets: ['my-preset'] }, ctxOf('other')), 'PRE||POST')
t('preset- 前缀归一', await run({ text: 'INJ', presets: ['my-preset'] }, ctxOf('preset-my-preset')), 'PRE|INJ|POST')
t('总开关关闭', await run({ text: 'INJ', enabled: false }, ctxOf('any')), 'PRE||POST')
t('无文本 = 不注入', await run({}, ctxOf('any')), 'PRE||POST')
t('textFile 读取', await run({ textFile: tf }, ctxOf('any')), 'PRE|FROM-FILE|POST')
t('textFile 缺失退回 text', await run({ textFile: '/nope/nope.txt', text: 'FALLBACK' }, ctxOf('any')), 'PRE|FALLBACK|POST')
t('空 context 不抛错', await run({ text: 'INJ' }, {}), 'PRE|INJ|POST')
t('undefined context 不抛错', await run({ text: 'INJ' }, undefined), 'PRE|INJ|POST')
t('cwd 命中（尾斜杠归一）', await run({ text: 'INJ', cwds: ['/work'] }, ctxOf('any', '/work/')), 'PRE|INJ|POST')
t('cwd 未命中', await run({ text: 'INJ', cwds: ['/other'] }, ctxOf('any')), 'PRE||POST')
t('stateFile=false 关闭', await run({ text: 'INJ', stateFile: sf }, ctxOf('any')), 'PRE||POST')
fs.writeFileSync(sf, JSON.stringify({ enabled: true }), 'utf8')
t('stateFile=true 开启', await run({ text: 'INJ', stateFile: sf }, ctxOf('any')), 'PRE|INJ|POST')
t('会话白名单命中', await run({ text: 'INJ', sessions: ['s1'] }, ctxOf('any', '/work', 's1')), 'PRE|INJ|POST')
t('会话白名单未命中', await run({ text: 'INJ', sessions: ['s1'] }, ctxOf('any', '/work', 's2')), 'PRE||POST')

/* 自定义变量名 */
const ctxVar = new Context()
ctxVar.plugin(SystemPrompt, {})
if (!ctxVar.systemPrompt) new SystemPrompt(ctxVar, {})
await ctxVar.plugin(plugin, { variable: 'my_var', text: 'X' })
ctxVar.systemPrompt.section({ name: 'p', order: 999, text: 'A|{{my_var}}|B', complete: true })
t('自定义变量名', renderPrompt(await ctxVar.systemPrompt.assemble(ctxOf('any'))), 'A|X|B')

/* 非法变量名必须抛错（DSH 的 VARIABLE_NAME 是 /^[a-z][a-z0-9_]*$/） */
let threw = ''
try {
  const ctxBad = new Context()
  ctxBad.plugin(SystemPrompt, {})
  if (!ctxBad.systemPrompt) new SystemPrompt(ctxBad, {})
  await ctxBad.plugin(plugin, { variable: 'Bad-Name' })
} catch (e) { threw = e.message }
t('非法变量名抛错', threw.includes('不合法'), true)

/* 没有 complete 段时，普通 section 照常拼接，插件不干扰 */
{
  const ctx = new Context()
  ctx.plugin(SystemPrompt, {})
  if (!ctx.systemPrompt) new SystemPrompt(ctx, {})
  await ctx.plugin(plugin, { text: 'INJ' })
  ctx.systemPrompt.section({ name: 'plain', order: 10, text: 'PLAIN' })
  t('无 complete 段时普通 section 照常存在',
    (await ctx.systemPrompt.assemble(ctxOf('any'))).sections.some((s) => s.name === 'plain'), true)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
