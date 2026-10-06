/* 共享工具：profile 定位、cordis.patch.yml 的行级 YAML 操作、插件挂载状态检查。
 *
 * 这里刻意不引入 YAML 库：DSH 的 profile 补丁文件由 GUI 与 sync 脚本共同维护，
 * 我们只做「定位一个块 + 在块尾追加/删除一行」这种最小改动，行级操作比整体
 * parse→stringify 更不容易破坏原文件的格式与注释。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PLUGIN_NAME = 'dsh-prompt-inject'
export const PLUGIN_ID = 'prompt-inject'

export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const PROFILE = process.env.DSH_PROFILE || 'desktop'
export const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE)
export const PATCH_YML = path.join(PROFILE_DIR, 'cordis.patch.yml')
export const PKG_JSON = path.join(PROFILE_DIR, 'package.json')
export const PLUGIN_DIR = path.join(PROFILE_DIR, 'node_modules', PLUGIN_NAME)

export const readText = (file) => fs.readFileSync(file, 'utf8')
export const eolOf = (raw) => (raw.includes('\r\n') ? '\r\n' : '\n')
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function requireFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label || '文件'}不存在: ${file}`)
  return file
}

export function backup(file) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dst = `${file}.bak-prompt-inject-${ts}`
  fs.copyFileSync(file, dst)
  return dst
}

export const indentOf = (line) => (line.match(/^[ \t]*/) || [''])[0].length

/** 该行是否是 YAML 列表项 `- xxx`（用于判断段落边界）。 */
export const isListItem = (line) => /^[ \t]*- /.test(line)

/**
 * 找出某个顶层条目的行范围 `[start, end]`（end 为闭区间，指向该条目最后一行）。
 * 以「缩进不超过起始行缩进的下一行列表项」或文件结尾作为边界。
 */
export function findEntryRange(lines, idRe) {
  const start = lines.findIndex((l) => idRe.test(l))
  if (start < 0) return null
  const base = indentOf(lines[start])
  let end = lines.length - 1
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') continue
    if (indentOf(l) <= base && isListItem(l)) { end = i - 1; break }
  }
  return { start, end, base }
}

/**
 * 在 `[from, to]` 内找出 persona 的 `prefix` 块。
 * 支持块标量（`|-` `|` `>-` `>`）与单行标量（`prefix: xxx`）。
 * @returns {{kind:'block'|'inline', lineIdx:number, insertIdx:number, indent:number, endIdx:number}|null}
 */
export function findPrefix(lines, from, to) {
  for (let i = from; i <= to; i++) {
    const m = lines[i].match(/^([ \t]*)prefix:\s*(.*)$/)
    if (!m) continue
    const indent = m[1].length
    const rest = m[2].trim()

    if (/^[|>][-+]?\d*$/.test(rest)) {
      // 块标量：内容从下一行开始，缩进必须大于 prefix 行的缩进
      let endIdx = i
      for (let j = i + 1; j <= to; j++) {
        const l = lines[j]
        if (l.trim() === '') { endIdx = j; continue }
        if (indentOf(l) <= indent) break
        endIdx = j
      }
      // 回退掉块尾的纯空行，避免把空行算进内容
      while (endIdx > i && lines[endIdx].trim() === '') endIdx--
      return { kind: 'block', lineIdx: i, insertIdx: endIdx, indent, endIdx }
    }

    if (rest === '' || rest === '""' || rest === "''") {
      // 空标量：在下一行插入一个缩进更深的块
      return { kind: 'block', lineIdx: i, insertIdx: i, indent, endIdx: i }
    }

    return { kind: 'inline', lineIdx: i, insertIdx: i, indent, endIdx: i }
  }
  return null
}

/** 在整份文件里找出所有含 `{{variable}}` 的行。 */
export function findVariableRefs(lines, variable) {
  const re = new RegExp(`\\{\\{\\s*${escapeRe(variable)}\\s*\\}\\}`)
  const out = []
  lines.forEach((l, i) => { if (re.test(l)) out.push({ lineIdx: i, line: l }) })
  return out
}

/** 读取 profile 的 package.json，返回 { json, eol }。 */
export function readProfilePkg() {
  requireFile(PKG_JSON, 'profile package.json')
  const raw = readText(PKG_JSON)
  return { json: JSON.parse(raw), raw, eol: eolOf(raw) }
}

/** 该插件是否已列在 profile 的 dsh.profile.bundles 里。 */
export function bundlesOf(json) {
  return json?.dsh?.profile?.bundles
}

export function isInstalled() {
  try {
    const { json } = readProfilePkg()
    const b = bundlesOf(json)
    return Array.isArray(b) && b.includes(PLUGIN_NAME)
  } catch {
    return false
  }
}

export function packagePresent() {
  return fs.existsSync(path.join(PLUGIN_DIR, 'package.json'))
}
