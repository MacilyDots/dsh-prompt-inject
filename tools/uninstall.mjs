/* 从 profile 的 dsh.profile.bundles 里移除本插件。
 *
 * 安全闸：只要 profile 的 cordis.patch.yml 里还留着 {{<variable>}} 引用，就拒绝执行。
 * 因为引用留着而注册该变量的插件不加载，DSH 渲染那个预设的系统提示时会抛
 * `unknown prompt variable`，该预设的整条会话链路都会失败。
 *
 * 用法: node tools/uninstall.mjs [--variable <名>] [--dry] [--force]
 *   --force  明知有引用仍然卸载（不建议；只在你自己确认过引用无害时用）
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  PATCH_YML, PKG_JSON, PLUGIN_DIR, PLUGIN_NAME, backup, eolOf, readProfilePkg, readText, escapeRe,
} from './_shared.mjs'

const argv = process.argv.slice(2)
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const DRY = argv.includes('--dry')
const FORCE = argv.includes('--force')

/* ── 解析本插件实际使用的变量名：profile 覆盖 > bundle patch > 默认 ── */
let variable = argOf('--variable') || ''

if (!variable && fs.existsSync(PATCH_YML)) {
  const raw = readText(PATCH_YML)
  const lines = raw.split(eolOf(raw))
  let inSeg = false
  for (const l of lines) {
    if (/^[ \t]*- id:\s*prompt-inject\s*$/.test(l)) { inSeg = true; continue }
    if (!inSeg) continue
    if (/^[ \t]*- id:/.test(l)) break
    const m = l.match(/^[ \t]*variable:\s*(.+?)\s*$/)
    if (m) { variable = m[1].replace(/^['"]|['"]$/g, ''); break }
  }
}

if (!variable) {
  const bp = path.join(PLUGIN_DIR, 'cordis.patch.yml')
  if (fs.existsSync(bp)) {
    const m = readText(bp).match(/^[ \t]*variable:\s*(.+?)\s*$/m)
    if (m) variable = m[1].replace(/^['"]|['"]$/g, '')
  }
}
if (!variable) variable = 'inject'

/* ── 安全闸 ───────────────────────────────────────────────────────── */
const refRe = new RegExp(`\\{\\{\\s*${escapeRe(variable)}\\s*\\}\\}`)
const hits = []
if (fs.existsSync(PATCH_YML)) {
  const raw = readText(PATCH_YML)
  raw.split(eolOf(raw)).forEach((l, i) => { if (refRe.test(l)) hits.push({ i, l }) })
}

if (hits.length > 0 && !FORCE) {
  console.error(`拒绝执行：profile 里还留着 ${hits.length} 处 {{${variable}}} 引用。`)
  for (const h of hits) console.error(`  L${h.i + 1}: ${h.l.trim().slice(-70)}`)
  console.error('')
  console.error('卸载后这些引用会变成未注册变量，DSH 渲染对应预设时会抛')
  console.error('`unknown prompt variable`，那个预设的会话整条失败。')
  console.error('')
  console.error('先摘引用，再卸载：')
  console.error(`  node tools/disable.mjs --preset <preset-id> --variable ${variable}`)
  console.error(`  node tools/uninstall.mjs`)
  console.error('')
  console.error('（确实要先卸插件、引用稍后再清，可以加 --force。）')
  process.exit(1)
}

/* ── 从 bundles 移除 ──────────────────────────────────────────────── */
const { json, eol } = readProfilePkg()
const bundles = json?.dsh?.profile?.bundles

if (!Array.isArray(bundles) || !bundles.includes(PLUGIN_NAME)) {
  console.log(`${PLUGIN_NAME} 不在 dsh.profile.bundles 里，无需改动。`)
  console.log('（插件包目录如果还在，可以自行删除：' + PLUGIN_DIR + '）')
  process.exit(0)
}

const next = bundles.filter((b) => b !== PLUGIN_NAME)
json.dsh.profile.bundles = next
const text = JSON.stringify(json, null, 2).split('\n').join(eol) + eol

if (DRY) {
  console.log('--dry：未写入。')
  console.log(`会从 dsh.profile.bundles 移除 ${PLUGIN_NAME}（${bundles.length} 项 → ${next.length} 项）`)
  process.exit(0)
}

const bak = backup(PKG_JSON)
fs.writeFileSync(PKG_JSON, text, 'utf8')
console.log(`备份: ${bak}`)
console.log(`已移除 ${PLUGIN_NAME} → ${PKG_JSON}（bundles 现共 ${next.length} 项）`)
console.log('')
console.log('插件包目录仍在（' + PLUGIN_DIR + '），确认不需要后可自行删除。')
console.log('重启 DSH 后生效。')
