/* dsh-prompt-inject — 给「用了 complete:true 的 agent 预设」注入一段附加提示文本。
 *
 * 为什么需要它
 * ------------
 * DSH 的 system prompt 由若干 section 拼成。`@deepseek-ai/dsh-system-prompt` 的
 * `assemble()` 里有一条硬规则（lib/index.js）：
 *
 *     sections: completeSection === void 0 ? transformed.sections : [completeSection]
 *
 * 只要有任何一个 section 带 `complete: true`（典型是 persona 独占人格，例如
 * `@deepseek-ai/dsh-persona` 的 `complete: true` 配置），**最终只剩它一个 section**。
 * 也就是说：往注册表里再 `section()` 加多少段都是白加，那些段会被整段丢掉。
 *
 * 唯一还能进得去的地方是「prompt 变量插值」：complete 段虽然不是拼接对象，但它
 * 照样过 renderPrompt() 的 interpolate()，所以只要在它的文本里写 `{{变量名}}`，
 * 就会被展开成变量 provider 的返回值。
 *
 * 这个插件就干一件事：把「一段文本」注册成一个 prompt 变量，供预设前缀引用。
 * 插件本身不含任何内容，文本由使用者通过配置提供。
 *
 * 重要安全语义
 * ------------
 * `interpolate()` 对**未注册**的变量是抛错的，不是忽略：
 *
 *     unknown prompt variable "{{x}}" in section "..."
 *
 * 而且这个错发生在渲染系统提示时 —— 整条会话链路会失败。所以：
 *   - 前缀里写了引用，就必须保证注册该变量的插件处于加载状态；
 *   - 卸载插件之前，先用 tools/disable.mjs 把引用摘掉。
 * tools/check.mjs 用来检查这个配对状态。
 *
 * 为什么 provider 永远不抛错
 * -------------------------
 * `assemble()` 是同步调用每个 provider 的：
 *
 *     variables[name] = provider(context)
 *
 * provider 一抛，assemble 就抛，会话就废。所以这里所有读文件、读状态的动作
 * 一律 try/catch 兜住，最坏情况返回空串（渲染时被 filter 掉，等于不注入）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-prompt-inject'

/** 依赖 systemPrompt 服务；服务未就绪时 apply 不会被调用。 */
export const inject = ['systemPrompt']

/** 变量名规则与 @deepseek-ai/dsh-system-prompt 的 VARIABLE_NAME 一致。 */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

const DEFAULTS = {
  /** 注册的变量名；预设前缀里写 {{<这个名字>}}。 */
  variable: 'inject',
  /** 内联文本。与 textFile 二选一，textFile 优先。 */
  text: '',
  /** 文本文件路径（UTF-8）。改动后按 mtime 自动重载，不必重启 DSH。 */
  textFile: '',
  /** agent 预设 id 白名单（对应会话创建记录里的 agentPreset）。空数组 = 不限制。 */
  presets: [],
  /** 会话 id 白名单。空数组 = 不限制。 */
  sessions: [],
  /** 工作目录白名单（会话 header.cwd）。空数组 = 不限制。 */
  cwds: [],
  /** 总开关。 */
  enabled: true,
  /** 外部开关文件（JSON）。用于跟随别的插件的开关状态。 */
  stateFile: '',
  /** 在上面那个 JSON 里读哪个键；该键必须严格等于 true 才注入。 */
  stateKey: 'enabled',
  /** 打开后往 %DSH_HOME%/prompt-inject.log 记一行每次求值的结果。 */
  debug: false,
}

const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** 预设 id 归一：`preset-my-preset` 与 `my-preset` 视为同一个。 */
const normalizePreset = (id) => String(id || '').replace(/^preset-/, '')

/** 路径归一：去尾部斜杠，统一小写盘符无关比较交给调用方。 */
const normalizePath = (p) => String(p || '').replace(/[\\/]+$/, '')

/** 按 mtime 缓存的 JSON 读取；任何异常都返回 undefined。 */
function makeJsonLoader(file) {
  let cache
  let stamp = -1
  return () => {
    if (!file) return undefined
    try {
      const st = fs.statSync(file)
      if (st.mtimeMs !== stamp) {
        cache = JSON.parse(fs.readFileSync(file, 'utf8'))
        stamp = st.mtimeMs
      }
      return cache
    } catch {
      return undefined
    }
  }
}

/** 按 mtime 缓存的文本读取；读不到就退回 fallback。 */
function makeTextLoader(file, fallback) {
  let cache
  let stamp = -1
  return () => {
    if (!file) return fallback
    try {
      const st = fs.statSync(file)
      if (st.mtimeMs !== stamp) {
        cache = fs.readFileSync(file, 'utf8')
        stamp = st.mtimeMs
      }
      return typeof cache === 'string' ? cache : fallback
    } catch {
      return fallback
    }
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }

  if (!VARIABLE_NAME.test(String(cfg.variable))) {
    throw new Error(
      `dsh-prompt-inject: 变量名 "${cfg.variable}" 不合法，必须匹配 ${String(VARIABLE_NAME)}`,
    )
  }

  const loadText = makeTextLoader(cfg.textFile, typeof cfg.text === 'string' ? cfg.text : '')
  const loadState = makeJsonLoader(cfg.stateFile)
  const presetAllow = (Array.isArray(cfg.presets) ? cfg.presets : []).map(normalizePreset)
  const sessionAllow = (Array.isArray(cfg.sessions) ? cfg.sessions : []).map(String)
  const cwdAllow = (Array.isArray(cfg.cwds) ? cfg.cwds : []).map(normalizePath)

  const log = (line) => {
    if (cfg.debug !== true) return
    try {
      fs.appendFileSync(
        path.join(dshHome(), 'prompt-inject.log'),
        `[${new Date().toISOString()}] ${line}\n`,
        'utf8',
      )
    } catch {
      /* 日志失败绝不能影响注入 */
    }
  }

  /** 求值：返回要插入的文本，或空串表示不注入。绝不抛错。 */
  const provider = (context) => {
    try {
      if (cfg.enabled !== true) return ''

      // 外部开关（可选）
      if (cfg.stateFile) {
        const state = loadState()
        if (!state || state[cfg.stateKey] !== true) return ''
      }

      const session = context?.agent?.session
      const header = session?.header

      if (presetAllow.length > 0) {
        const preset = normalizePreset(header?.agentPreset)
        if (!presetAllow.includes(preset)) return ''
      }

      if (sessionAllow.length > 0) {
        const sid = String(session?.id || header?.id || '')
        if (!sessionAllow.includes(sid)) return ''
      }

      if (cwdAllow.length > 0) {
        const cwd = normalizePath(header?.cwd)
        if (!cwdAllow.includes(cwd)) return ''
      }

      const text = loadText()
      log(`preset=${header?.agentPreset} len=${typeof text === 'string' ? text.length : 0}`)
      return typeof text === 'string' ? text : ''
    } catch (e) {
      log(`ERROR ${e && e.message}`)
      return ''
    }
  }

  try {
    ctx.systemPrompt.variable(cfg.variable, provider)
  } catch (e) {
    throw new Error(
      `dsh-prompt-inject: 注册 prompt 变量 "${cfg.variable}" 失败 —— ${e && e.message}\n` +
        `（同名变量已被其它插件注册时也会走到这里，换一个 variable 名即可）`,
    )
  }
}
