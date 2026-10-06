/* 从目标预设的 persona prefix 里摘掉 {{variable}}。
 *
 * 卸载插件之前必须先跑这个 —— 引用留着而插件没加载，DSH 渲染该预设的系统
 * 提示时会抛 `unknown prompt variable`，整条会话链路失败。
 * uninstall.mjs 会强制检查这一步。
 *
 * 幂等：没有引用就直接退出。
 * 备份：改动前在同目录写一份 .bak-prompt-inject-<时间戳>。
 *
 * 用法: node tools/disable.mjs --preset preset-my-preset [--variable inject] [--dry]
 */

import fs from 'node:fs'
import {
  PATCH_YML, readText, eolOf, backup, escapeRe, findEntryRange, findPrefix, requireFile,
} from './_shared.mjs'

const argv = process.argv.slice(2)
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const DRY = argv.includes('--dry')
const variable = argOf('--variable') || 'inject'
const presetArg = argOf('--preset')

if (!presetArg) {
  console.error('用法: node tools/disable.mjs --preset <preset-id> [--variable inject] [--dry]')
  process.exit(2)
}

requireFile(PATCH_YML, 'profile cordis.patch.yml')
const raw = readText(PATCH_YML)
const eol = eolOf(raw)
const lines = raw.split(eol)

const candidates = [...new Set([presetArg, `preset-${presetArg}`])]
let range = null
let usedId = ''
for (const c of candidates) {
  range = findEntryRange(lines, new RegExp(`^[ \\t]*- id:\\s*${escapeRe(c)}\\s*$`))
  if (range) { usedId = c; break }
}
if (!range) {
  console.error(`找不到 preset 条目（试过: ${candidates.join(' / ')}）`)
  process.exit(2)
}

let personaStart = -1
for (let i = range.start; i <= range.end; i++) {
  if (/^[ \t]*- id:\s*persona\s*$/.test(lines[i])) { personaStart = i; break }
}
if (personaStart < 0) {
  console.error(`preset "${usedId}" 里没有 '- id: persona' 子条目`)
  process.exit(2)
}

const prefix = findPrefix(lines, personaStart, range.end)
if (!prefix) {
  console.error(`preset "${usedId}" 的 persona 条目里找不到 prefix 字段`)
  process.exit(2)
}

const refRe = new RegExp(`\\{\\{\\s*${escapeRe(variable)}\\s*\\}\\}`)

/* 倒序扫描，删除整行时不影响前面的下标。 */
let removed = 0
for (let i = prefix.endIdx; i >= prefix.lineIdx; i--) {
  if (!refRe.test(lines[i])) continue
  const stripped = lines[i].replace(refRe, '').replace(/\s+$/, '')
  if (stripped.trim() === '') {
    lines.splice(i, 1)
    console.log(`L${i + 1} 该行只剩引用，整行删除`)
  } else {
    lines[i] = stripped
    console.log(`L${i + 1} 移除引用 → ${stripped.trim().slice(-70)}`)
  }
  removed++
}

if (removed === 0) {
  console.log(`preset "${usedId}" 里没有 {{${variable}}} 引用，无需改动。`)
  process.exit(0)
}

if (DRY) {
  console.log(`\n--dry：共 ${removed} 处，未写入。`)
  process.exit(0)
}

const bak = backup(PATCH_YML)
fs.writeFileSync(PATCH_YML, lines.join(eol), 'utf8')
console.log(`\n共移除 ${removed} 处。`)
console.log(`备份: ${bak}`)
console.log(`已写入: ${PATCH_YML}`)
console.log(`\n下一步：node tools/check.mjs 复查；重启 DSH 后生效。`)
