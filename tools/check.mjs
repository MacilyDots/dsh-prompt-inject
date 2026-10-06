/* 配对检查：确认「变量引用」与「插件挂载」是成对的。
 *
 * 背景：@deepseek-ai/dsh-system-prompt 的 interpolate() 对未注册变量是抛错，
 * 不是忽略。一旦预设前缀里留着 {{x}} 而注册 x 的插件没被加载，DSH 渲染该
 * 预设的系统提示时会抛 `unknown prompt variable`，整条会话链路失败。
 *
 * 所以这个检查只有三种结论：
 *   引用有 + 已挂载  -> 安全
 *   引用有 + 未挂载  -> 危险（必须立刻修）
 *   引用无 + 已挂载  -> 无害（变量注册了但没人引用，只是白注册）
 *
 * 退出码：0 = 安全，1 = 危险。
 *
 * 用法: node tools/check.mjs [--variable <名>] [--profile <名>]
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  DSH_HOME, PROFILE, PROFILE_DIR, PATCH_YML, PLUGIN_NAME, PLUGIN_DIR,
  eolOf, findEntryRange, findPrefix, findVariableRefs, isInstalled,
  packagePresent, readProfilePkg, readText, requireFile, escapeRe,
} from './_shared.mjs'

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const VARIABLE_RE = /^[a-z][a-z0-9_]*$/
const DANGER = []
const ok = (s) => `✅ ${s}`
const bad = (s) => `❌ ${s}`

console.log(`dsh-prompt-inject 状态检查`)
console.log(`profile: ${PROFILE_DIR}\n`)

/* ── [1] 插件包是否在 profile 的 node_modules 里 ───────────────────── */
const pkgOk = packagePresent()
console.log(`[1] 插件包       : ${pkgOk ? ok(`已就位 (${path.join('node_modules', PLUGIN_NAME)})`) : bad('未找到')}`)

/* ── [2] 是否列在 dsh.profile.bundles（真正的挂载机制）─────────────── */
let bundlesOk = false
try {
  const { json } = readProfilePkg()
  const b = json?.dsh?.profile?.bundles
  bundlesOk = Array.isArray(b) && b.includes(PLUGIN_NAME)
  console.log(`[2] bundle 挂载  : ${bundlesOk ? ok(`已列在 dsh.profile.bundles (共 ${b.length} 项)`) : bad('未列在 dsh.profile.bundles')}`)
} catch (e) {
  console.log(`[2] bundle 挂载  : ${bad(`读 profile package.json 失败: ${e.message}`)}`)
}

/* ── [3] 变量名：profile 覆盖优先，其次插件自带 bundle patch，最后默认值 ── */
let variable = argOf('--variable') || ''
let textFile = ''
let source = ''

if (!variable && fs.existsSync(PATCH_YML)) {
  const lines = readText(PATCH_YML).split(eolOf(readText(PATCH_YML)))
  const range = findEntryRange(lines, new RegExp(`^[ \\t]*- id:\\s*${escapeRe('prompt-inject')}\\s*$`))
  if (range) {
    for (let i = range.start; i <= range.end; i++) {
      const mv = lines[i].match(/^[ \t]*variable:\s*(.+?)\s*$/)
      if (mv && !variable) { variable = mv[1].replace(/^['"]|['"]$/g, ''); source = 'profile cordis.patch.yml' }
      const mf = lines[i].match(/^[ \t]*textFile:\s*(.+?)\s*$/)
      if (mf && !textFile) textFile = mf[1].replace(/^['"]|['"]$/g, '')
    }
  }
}

if (!variable) {
  const bundlePatch = path.join(PLUGIN_DIR, 'cordis.patch.yml')
  if (fs.existsSync(bundlePatch)) {
    const mv = readText(bundlePatch).match(/^[ \t]*variable:\s*(.+?)\s*$/m)
    if (mv) { variable = mv[1].replace(/^['"]|['"]$/g, ''); source = '插件自带 cordis.patch.yml' }
  }
}

if (!variable) { variable = 'inject'; source = '默认值' }

const varOk = VARIABLE_RE.test(variable)
console.log(`[3] 变量名       : ${varOk ? ok(`${variable}  (来源: ${source})`) : bad(`${variable} 不合法，必须匹配 ${String(VARIABLE_RE)}`)}`)

/* ── [4] 文本来源 ─────────────────────────────────────────────────── */
if (textFile) {
  if (fs.existsSync(textFile)) {
    const size = fs.statSync(textFile).size
    console.log(`[4] 文本来源     : ${ok(`textFile = ${textFile}  (${size} 字节)`)}`)
  } else {
    console.log(`[4] 文本来源     : ${bad(`textFile 不存在: ${textFile}`)}`)
  }
} else {
  console.log(`[4] 文本来源     : ⚠️  未配置 textFile（将使用内联 text；两者都空则不注入任何内容）`)
}

/* ── [5] 引用位置：本插件的，以及该文件里全部变量引用 ──────────────── */
let refs = []
if (fs.existsSync(PATCH_YML)) {
  const raw = readText(PATCH_YML)
  const lines = raw.split(eolOf(raw))
  refs = findVariableRefs(lines, variable)

  // 反查某一行属于哪个 preset 条目：先算出每个 preset 条目的行范围，再看该行落在哪个里。
  // （不能简单地「往上找最近的 - id:」—— 那会命中 persona 这类子条目。）
  const presetRanges = []
  lines.forEach((l) => {
    const m = l.match(/^[ \t]*- id:\s*(preset-\S+)\s*$/)
    if (!m) return
    const r = findEntryRange(lines, new RegExp(`^[ \\t]*- id:\\s*${escapeRe(m[1])}\\s*$`))
    if (r) presetRanges.push({ id: m[1], start: r.start, end: r.end })
  })
  const ownerOf = (lineIdx) => {
    for (const r of presetRanges) {
      if (lineIdx >= r.start && lineIdx <= r.end) return r.id
    }
    return '(不在任何 preset 条目内)'
  }

  console.log(`[5] {{${variable}}} 引用 : ${refs.length} 处`)
  for (const r of refs) {
    console.log(`      ${ownerOf(r.lineIdx)}  L${r.lineIdx + 1}: ${r.line.trim().slice(-70)}`)
  }

  // 全部变量引用：任何一条「有引用但注册方没加载」都会炸掉那个预设的会话链路，
  // 而且不限于本插件注册的名字 —— 所以这里把整个文件扫一遍。
  const all = new Map()
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const nm = m[1].trim()
      if (!all.has(nm)) all.set(nm, [])
      all.get(nm).push({ lineIdx: i, owner: ownerOf(i) })
    }
  })

  console.log('')
  if (all.size === 0) {
    console.log(`[5b] 全量变量引用 : 该文件里没有任何 {{...}} 引用`)
  } else {
    console.log(`[5b] 全量变量引用 : 共 ${all.size} 个名字`)
    for (const [nm, hits] of all) {
      const mark = nm === variable ? '← 本插件注册' : '← 注册方不在本插件职责内，需自行确认'
      console.log(`      {{${nm}}}  ${hits.length} 处  ${mark}`)
      for (const h of hits) console.log(`          ${h.owner}  L${h.lineIdx + 1}`)
    }
  }
} else {
  console.log(`[5] 引用检查     : ${bad(`找不到 ${PATCH_YML}`)}`)
}

/* ── [6] 结论 ─────────────────────────────────────────────────────── */
console.log('')
if (refs.length > 0 && !bundlesOk) {
  DANGER.push('有引用但未挂载')
  console.log(bad('危险：存在变量引用，但插件不在 dsh.profile.bundles 里。'))
  console.log('    DSH 渲染这些预设的系统提示时会抛 `unknown prompt variable`，')
  console.log('    该预设的整条会话链路都会失败（回信、对话都发不出去）。')
  console.log('')
  console.log('    修复二选一：')
  console.log('      node tools/install.mjs                              # 把插件挂回去')
  console.log(`      node tools/disable.mjs --preset <preset-id>          # 或摘掉引用`)
} else if (refs.length > 0) {
  console.log(ok(`配对完整：${refs.length} 处引用，插件已挂载。`))
  if (!pkgOk) {
    DANGER.push('挂载了但包不在')
    console.log(bad('  但 node_modules 里找不到插件包 —— 挂载行会指向不存在的包，插件仍然加载不了。'))
  }
} else {
  console.log(ok('无变量引用 —— 当前不会注入任何内容，也不存在炸链路的可能。'))
  if (bundlesOk && pkgOk) console.log('    （插件已挂载但没人引用它，属于正常待用状态。）')
}

console.log('')
console.log(`DSH_HOME = ${DSH_HOME}`)
process.exit(DANGER.length > 0 ? 1 : 0)
