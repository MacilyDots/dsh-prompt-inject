/* 把 dsh-prompt-inject 挂进 profile。
 *
 * 挂载机制（实测确认）：DSH 的 profile 根是一份空条目列表，加载顺序是
 *   package.json 的 dsh.profile.bundles 里每个 bundle
 *   → cordis.patch.yml
 *   → --patch overlays
 * （见 profile 目录里 cordis.yml 的注释。）
 *
 * 所以「插件有没有被加载」由 package.json 的 bundles 决定，而不是 cordis.patch.yml。
 * 这一点很关键：cordis.patch.yml 会被 GUI 重写，bundles 列表不会。
 *
 * 用法: node tools/install.mjs [--dry]
 */

import fs from 'node:fs'
import path from 'node:path'
import { PKG_JSON, PLUGIN_DIR, PLUGIN_NAME, PROFILE_DIR, backup, readProfilePkg } from './_shared.mjs'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')

/* ── [1] 插件包必须先在 profile 的 node_modules 里 ─────────────────── */
if (!fs.existsSync(path.join(PLUGIN_DIR, 'package.json'))) {
  console.error(`找不到插件包: ${PLUGIN_DIR}`)
  console.error('')
  console.error('先把插件目录放到 profile 的 node_modules 下，二选一：')
  console.error('')
  console.error('  A. 复制（适合从本仓库直接装）：')
  console.error(`     robocopy "<本仓库路径>" "${PLUGIN_DIR}" /E /XD .git`)
  console.error('')
  console.error('  B. 用 pnpm 装本地路径（会在 package.json 里留下 file: 依赖）：')
  console.error(`     pnpm --dir "${PROFILE_DIR}" add "file:<本仓库路径>"`)
  console.error('')
  console.error('放好之后重跑本脚本。')
  process.exit(2)
}

/* ── [2] 追加到 dsh.profile.bundles ────────────────────────────────── */
const { json, eol } = readProfilePkg()
const bundles = json?.dsh?.profile?.bundles

if (!Array.isArray(bundles)) {
  console.error('profile 的 package.json 里没有 dsh.profile.bundles 数组 —— 无法自动挂载。')
  console.error('请手动在 dsh.profile.bundles 里加一项: ' + JSON.stringify(PLUGIN_NAME))
  process.exit(2)
}

if (bundles.includes(PLUGIN_NAME)) {
  console.log(`已挂载：${PLUGIN_NAME} 已在 dsh.profile.bundles 里，无需改动。`)
  process.exit(0)
}

bundles.push(PLUGIN_NAME)
const text = JSON.stringify(json, null, 2).split('\n').join(eol) + eol

if (DRY) {
  console.log('--dry：未写入。')
  console.log(`会往 dsh.profile.bundles 追加: ${PLUGIN_NAME}（当前 ${bundles.length - 1} 项 → ${bundles.length} 项）`)
  process.exit(0)
}

const bak = backup(PKG_JSON)
fs.writeFileSync(PKG_JSON, text, 'utf8')
console.log(`备份: ${bak}`)
console.log(`已挂载 ${PLUGIN_NAME} → ${PKG_JSON}`)
console.log(`dsh.profile.bundles 现共 ${bundles.length} 项。`)
console.log('')
console.log('下一步：')
console.log('  1) 在 profile 的 cordis.patch.yml 里给插件写配置（variable / textFile 等），或直接用默认值')
console.log('  2) node tools/enable.mjs --preset <preset-id>    # 给目标预设挂上 {{variable}} 引用')
console.log('  3) node tools/check.mjs                          # 复查配对')
console.log('  4) 重启 DSH')
