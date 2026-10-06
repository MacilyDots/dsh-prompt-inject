# dsh-prompt-inject

给「用了 `complete: true` 的 DSH agent 预设」注入一段附加提示文本。

## 为什么需要它

DSH 的系统提示（system prompt）由若干 section 拼装而成，注册入口是
`@deepseek-ai/dsh-system-prompt` 的 `ctx.systemPrompt.section()`。

但 `assemble()` 里有一条硬规则：

```js
sections: completeSection === void 0 ? transformed.sections : [completeSection]
```

只要有任何一个 section 带 `complete: true`（典型用法是 persona 独占整个人格，
例如 `@deepseek-ai/dsh-persona` 配 `complete: true`），**最终只剩它一个 section**
—— 往注册表里再 `section()` 加多少段，都会被整段丢掉。

还能进得去的入口只剩一个：**prompt 变量插值**。complete 段虽然不是拼接对象，
但它照样过 `renderPrompt()` 的 `interpolate()`，所以只要在它的文本里写
`{{变量名}}`，就会被展开成变量 provider 的返回值。

这个插件把「一段文本」注册成一个 prompt 变量，供预设前缀引用。
**插件本身不含任何内容**，文本由使用者通过配置提供。

## ⚠️ 一条必须先知道的规则

`interpolate()` 对**未注册**的变量是抛错，不是忽略：

```
unknown prompt variable "{{x}}" in section "..."
```

这个错误发生在渲染系统提示的时候 —— **那个预设的整条会话链路都会失败**
（对话、回信、任何模型调用都发不出去）。

所以：

- 前缀里写了 `{{x}}`，就必须保证注册 `x` 的插件处于加载状态；
- **卸载插件之前，先用 `tools/disable.mjs` 摘掉引用**；
- `tools/check.mjs` 检查这个配对，`tools/uninstall.mjs` 在还有引用时会**拒绝执行**。

## 安装

下文用 `%DSH_HOME%` 指 DSH 主目录（Windows 默认 `%USERPROFILE%\.dsh`，
其它平台 `~/.dsh`），profile 名默认 `desktop`。

1. 把本仓库放进 profile 的 node_modules：

   ```powershell
   robocopy "<本仓库路径>" "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-prompt-inject" /E /XD .git
   ```

2. 挂进 bundle 列表：

   ```powershell
   node tools/install.mjs
   ```

   DSH 的 profile 加载顺序是 `package.json` 的 `dsh.profile.bundles` →
   `cordis.patch.yml` → `--patch` overlays（见 profile 目录里 `cordis.yml` 的注释）。
   所以「插件有没有被加载」由 **bundles** 决定，而不是 `cordis.patch.yml`。
   这一点很关键：`cordis.patch.yml` 会被 GUI 重写，bundles 列表不会。

3. 给目标预设挂上变量引用：

   ```powershell
   node tools/enable.mjs --preset preset-<你的预设 id>
   ```

4. 复查配对：

   ```powershell
   node tools/check.mjs
   ```

5. 重启 DSH。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖插件配置：

```yaml
- id: prompt-inject
  config:
    variable: inject
    textFile: '<文本文件的绝对路径>'
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `variable` | `inject` | 注册的变量名；预设前缀里写 `{{<这个名字>}}`。必须匹配 `[a-z][a-z0-9_]*` |
| `textFile` | `''` | 文本文件路径（UTF-8）。改动后按 mtime 自动重载，不必重启 DSH |
| `text` | `''` | 内联文本。`textFile` 优先；两者都空则不注入任何内容 |
| `presets` | `[]` | agent 预设 id 白名单（对应会话创建记录里的 `agentPreset`）。空 = 不限制 |
| `sessions` | `[]` | 会话 id 白名单。空 = 不限制 |
| `cwds` | `[]` | 工作目录白名单（会话 `header.cwd`）。空 = 不限制 |
| `enabled` | `true` | 总开关 |
| `stateFile` | `''` | 外部开关文件（JSON）。用于跟随别的插件的开关状态 |
| `stateKey` | `enabled` | 在上面那个 JSON 里读哪个键；该键必须严格等于 `true` 才注入 |
| `debug` | `false` | 往 `%DSH_HOME%/prompt-inject.log` 记每次求值的结果 |

`variable` 和 `presets` 是两道独立的闸门：**引用决定「谁能拿到」**（没写引用的预设
根本不会展开这个变量），**provider 决定「什么时候返回空」**（白名单、开关、外部状态）。

## 工具

| 脚本 | 作用 |
|---|---|
| `tools/check.mjs` | 检查配对状态，并列出 profile 里**全部**变量引用。退出码 1 = 危险 |
| `tools/enable.mjs --preset <id>` | 往该预设 persona 的 `prefix` 末尾追加 `{{variable}}`（幂等） |
| `tools/disable.mjs --preset <id>` | 摘掉引用（幂等） |
| `tools/install.mjs` | 挂进 `dsh.profile.bundles` |
| `tools/uninstall.mjs` | 从 bundles 移除；**还有引用时拒绝执行** |

所有写操作都会先在同目录留一份 `.bak-prompt-inject-<时间戳>`。加 `--dry` 可以只看改动不落盘。

## 卸载

```powershell
node tools/disable.mjs --preset <preset-id>
node tools/uninstall.mjs
# 重启 DSH，然后自行删除 node_modules 里的插件目录
```

## 已知边界

- **一个 complete 段**：`assemble()` 检测到多个 `complete: true` 会直接抛
  `multiple complete prompt sections are active`。本插件不注册 section，不参与这个约束。
- **变量名不能撞车**：同名变量重复注册会抛 `prompt variable "x" is already registered`。
  和别的插件撞名时换一个 `variable` 值即可。
- **provider 永不抛错**：`assemble()` 同步调用每个 provider，provider 一抛会话就废。
  所以插件内部所有读文件、读状态的动作都被 try/catch 兜住，最坏情况返回空串（等于不注入）。

## 许可

MIT
