/* 往目标预设的 persona prefix 末尾挂上 {{variable}}。
 *
 * 为什么要挂在 persona 的 prefix 里：用了 `complete: true` 的 persona 段是
 * 最终唯一被保留的 section，而它照样过 renderPrompt() 的 interpolate()，
 * 所以变量引用写在这里才会被展开。
 *
 * 幂等：已经挂过就直接退出，不重复追加。
 * 备份：改动前在同目录写一份 .bak-prompt-inject-<时间戳>。
 *
 * 用法: node tools/enable.mjs --preset preset-my-preset [--variable inject] [--dry]
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
  console.error('用法: node tools/enable.mjs --preset <preset-id> [--variable inject] [--dry]')
  console.error('  例: node tools/enable.mjs --preset preset-my-preset')
  process.exit(2)
}
if (!/^[a-z][a-z0-9_]*$/.test(variable)) {
  console.error(`变量名 "${variable}" 不合法，必须匹配 /^[a-z][a-z0-9_]*$/（DSH 的 VARIABLE_NAME 规则）`)
  process.exit(2)
}

requireFile(PATCH_YML, 'profile cordis.patch.yml')
const raw = readText(PATCH_YML)
const eol = eolOf(raw)
const lines = raw.split(eol)

/* ── 定位 preset 条目（允许给 my-preset 或 preset-my-preset）───────────── */
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

/* ── 定位 persona 子条目 ──────────────────────────────────────────── */
let personaStart = -1
for (let i = range.start; i <= range.end; i++) {
  if (/^[ \t]*- id:\s*persona\s*$/.test(lines[i])) { personaStart = i; break }
}
if (personaStart < 0) {
  console.error(`preset "${usedId}" 里没有 '- id: persona' 子条目 —— 没有 complete 段就没有注入入口`)
  process.exit(2)
}

/* ── 定位 prefix 块 ──────────────────────────────────────────────── */
const prefix = findPrefix(lines, personaStart, range.end)
if (!prefix) {
  console.error(`preset "${usedId}" 的 persona 条目里找不到 prefix 字段`)
  process.exit(2)
}

const refRe = new RegExp(`\\{\\{\\s*${escapeRe(variable)}\\s*\\}\\}`)

/* ── 幂等检查 ────────────────────────────────────────────────────── */
for (let i = prefix.lineIdx; i <= prefix.endIdx; i++) {
  if (refRe.test(lines[i])) {
    console.log(`已挂过 {{${variable}}}（L${i + 1}），无需改动。`)
    process.exit(0)
  }
}

/* ── 追加 ────────────────────────────────────────────────────────── */
const ref = `{{${variable}}}`
if (prefix.kind === 'inline') {
  lines[prefix.lineIdx] = lines[prefix.lineIdx].replace(/\s+$/, '') + ' ' + ref
  console.log(`L${prefix.lineIdx + 1} 单行 prefix 末尾追加 ${ref}`)
} else if (prefix.insertIdx === prefix.lineIdx) {
  const ind = ' '.repeat(prefix.indent + 2)
  lines.splice(prefix.lineIdx + 1, 0, ind + ref)
  console.log(`L${prefix.lineIdx + 1} prefix 块为空，插入一行 ${ind}${ref}`)
} else {
  lines[prefix.insertIdx] = lines[prefix.insertIdx].replace(/\s+$/, '') + ' ' + ref
  console.log(`L${prefix.insertIdx + 1} prefix 块末尾追加 ${ref}`)
  console.log(`  该行现在是: ${lines[prefix.insertIdx].trim().slice(-70)}`)
}

if (DRY) {
  console.log('\n--dry：未写入。')
  process.exit(0)
}

const bak = backup(PATCH_YML)
fs.writeFileSync(PATCH_YML, lines.join(eol), 'utf8')
console.log(`\n备份: ${bak}`)
console.log(`已写入: ${PATCH_YML}`)
console.log(`\n下一步：node tools/check.mjs 复查配对状态；重启 DSH 后生效。`)
