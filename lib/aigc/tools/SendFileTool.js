import tools from "./registry.js"
import fs from "node:fs/promises"
import path from "node:path"

/** 允许发送的文件根目录 */
const ALLOWED_DIR = path.resolve("data/aigc/tmp")

tools.register({
  name: "send_file",
  description: `发送文件到当前QQ对话。支持文本文件(md/txt/json/html/js/css等)和二进制文件(png/pdf/zip等)。

典型用法:
1. 先用 run_script 生成文件内容并写入: writeFile("report.md", content)
2. 再用 send_file 发送: send_file({ filepath: "data/aigc/tmp/report.md", name: "GitHub日报.md" })
或者: send_file({ content: "直接内容", name: "message.txt" }) 直接发送文本内容`,

  parameters: {
    type: "object",
    properties: {
      filepath: {
        type: "string",
        description: "要发送的文件路径 (run_script 的 writeFile 返回的路径)。与 content 二选一。",
      },
      content: {
        type: "string",
        description: "直接发送的文本内容 (无需先写文件)。与 filepath 二选一。",
      },
      name: {
        type: "string",
        description: "显示的文件名，如 'report.md'、'data.json'。未指定时从 filepath 提取或使用默认名。",
      },
    },
  },

  execute: async (args, ctx) => {
    const { filepath, content, name } = args
    const e = ctx.event
    if (!e?.reply) return "无法发送: 缺少对话上下文"

    // 路径来源: 直接传内容
    if (content !== undefined && content !== null) {
      const buf = Buffer.from(String(content), "utf-8")
      const filename = name || "file.txt"
      try {
        const url = await Bot.fileToUrl({ buffer: buf, name: filename })
        await e.reply(segment.file(url, filename))
        return `文件 "${filename}" 已发送`
      } catch (err) {
        return `发送失败: ${err.message}`
      }
    }

    // 路径来源: 从磁盘读文件
    if (filepath) {
      // 安全校验: 只允许 data/aigc/tmp/ 下的文件
      const resolved = path.resolve(filepath)
      if (!resolved.startsWith(ALLOWED_DIR + path.sep) && resolved !== ALLOWED_DIR) {
        return `安全限制: 只能发送 ${ALLOWED_DIR} 目录下的文件`
      }

      let buf
      try {
        buf = await fs.readFile(resolved)
      } catch (err) {
        return `读取文件失败: ${err.message}`
      }

      const filename = name || path.basename(resolved)
      try {
        const url = await Bot.fileToUrl({ buffer: buf, name: filename })
        await e.reply(segment.file(url, filename))
        const size = (buf.length / 1024).toFixed(1)
        return `文件 "${filename}" (${size}KB) 已发送`
      } catch (err) {
        return `发送失败: ${err.message}`
      }
    }

    return "请提供 filepath 或 content 参数"
  },
})
