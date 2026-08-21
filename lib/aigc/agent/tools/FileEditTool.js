import agentTools from "../registry.js"
import fs from "node:fs/promises"
import log from "../../helpers/log.js"
import { resolvePath } from "./utils.js"

/** 把全文中的字节偏移映射到行号 */
function offsetToLine(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") line++
  }
  return line
}

agentTools.register({
  name: "file_edit",
  description: `局部精确修改文件 — 将 old_text 替换为 new_text，replace_all: true 时替换全部。

- 只做局部替换，不整文件重写；新建或整体重写用 file_write
- old_text 必须与文件内容逐字符一致；未找到会报错并返回文件首尾内容
- 未设 replace_all 时 old_text 必须唯一匹配，多处匹配会拒绝修改
- new_text 为空字符串等于删除该段文本`,
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "文件路径 (绝对路径，或相对 当前目录的相对路径)" },
      old_text: { type: "string", description: "要被替换的原文，必须逐字符匹配" },
      new_text: { type: "string", description: "替换后的新文本，可为空字符串(删除)" },
      replace_all: {
        type: "boolean",
        description: "true=替换所有匹配处，false(默认)=只替换第一处",
      },
    },
    required: ["file", "old_text"],
  },

  execute: async (args, ctx) => {
    const { file, old_text, new_text = "", replace_all = false } = args
    if (!file) return "请提供文件路径 (file)"
    if (typeof old_text !== "string" || !old_text) return "请提供要替换的原文 (old_text)"
    if (typeof new_text !== "string") return "new_text 必须是字符串"

    const filepath = resolvePath(file)

    let content
    try {
      content = await fs.readFile(filepath, "utf-8")
    } catch (err) {
      return `读取文件失败: ${err.message}`
    }

    // CRLF/LF 兼容: 匹配在标准化文本上进行, 写回时按原行尾恢复,
    // 避免 Windows 文件因 old_text 缺少 \r 匹配失败, 也避免整文件行尾被改写
    const isCRLF = /\r\n/.test(content)
    const norm = str => str.replace(/\r\n/g, "\n")
    const normalized = norm(content)
    const matchText = norm(old_text)
    const replaceText = norm(new_text)

    // 统计匹配次数
    let count = 0
    let idx = 0
    while ((idx = normalized.indexOf(matchText, idx)) !== -1) {
      count++
      idx += matchText.length
    }

    if (count === 0) {
      // 未命中 → 给出文件首尾内容帮助 Agent 修正 old_text
      const head = content.slice(0, 200)
      const tail = content.length > 200 ? content.slice(-200) : ""
      return `未找到匹配文本。请检查 old_text 与文件内容是否逐字符一致(含缩进/空格/换行)。\n\n文件: ${filepath}\n文件头部:\n${head}\n${tail ? `\n文件尾部:\n${tail}` : ""}`
    }

    // 非 replace_all 时若匹配多处 → 拒绝, 防止模型凭片段误修文件其他位置
    if (count > 1 && !replace_all) {
      return `修改拒绝: old_text 在文件中匹配到了 ${count} 处，不唯一！请在 old_text 中包含上方或下方更多上下文代码行(如函数名、缩进结构)，使其在文件中唯一后再试。`
    }

    const applied = replace_all ? normalized.split(matchText).join(replaceText) : normalized.replace(matchText, replaceText)
    const apply = isCRLF ? applied.replace(/\n/g, "\r\n") : applied

    try {
      await fs.writeFile(filepath, apply, "utf-8")
    } catch (err) {
      return `写入失败: ${err.message}`
    }

    // 计算修改位置的行号
    const firstIndex = normalized.indexOf(matchText)
    const lineNo = offsetToLine(normalized, firstIndex)
    const changed = replace_all ? count : 1

    log.info(`[Agent-FileEdit] ${filepath}: 替换 ${changed}/${count} 处 (行 ${lineNo})`)
    return `已替换 ${changed}/${count} 处匹配 (文件: ${filepath})\n首次修改位置: 第 ${lineNo} 行\n替换后文件共 ${apply.split("\n").length} 行。可用 file_view 或 bash 验证结果。`
  },
})
