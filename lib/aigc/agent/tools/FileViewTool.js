import agentTools from "../registry.js"
import fs from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"
import { fileTypeFromBuffer } from "file-type"
import { imageSize } from "image-size"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const MAX_FILE_BYTES = 50 * 1024 * 1024 // 单文件 > 50MB 拒绝
const BINARY_CHECK_BYTES = 4096
const MAX_PDF_CHARS = 20000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

function resolvePath(file, ctx) {
  return path.isAbsolute(file) ? path.resolve(file) : path.resolve(process.cwd(), file)
}

/** PDF 文本操作符转义还原 */
function unescapePdf(s) {
  return s
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\[0-7]{1,3}/g, m => String.fromCharCode(parseInt(m.slice(1), 8)))
}

/** PDF 字符串解码: UTF-16BE (0xFE 0xFF BOM 前缀) 转 Unicode，其余按字面 */
function decodePdfString(s) {
  const unescaped = unescapePdf(s)
  if (unescaped.charCodeAt(0) === 0xfe && unescaped.charCodeAt(1) === 0xff) {
    let out = ""
    for (let i = 2; i + 1 < unescaped.length; i += 2) {
      out += String.fromCharCode((unescaped.charCodeAt(i) << 8) | unescaped.charCodeAt(i + 1))
    }
    return out
  }
  return unescaped
}

/**
 * 基础 PDF 文本提取: 解 FlateDecode 流 → 解析 BT/ET 文本块 → Tj/TJ 操作符。
 * 对未加密、含文本层的 PDF 有效；扫描版/加密 PDF 提取不到文本会返回空。
 */
function extractPdfText(buf) {
  const pages = []
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  const latin = buf.toString("latin1")
  let m
  while ((m = streamRe.exec(latin)) !== null) {
    let data
    try {
      data = zlib.inflateSync(Buffer.from(m[1], "latin1"))
    } catch {
      continue // 非 FlateDecode 或不可解压的流跳过
    }
    const content = data.toString("latin1")
    if (!content.includes("BT")) continue
    const pageText = []
    const btRe = /BT([\s\S]*?)ET/g
    let bm
    while ((bm = btRe.exec(content)) !== null) {
      const block = bm[1]
      const tjRe = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g
      let tm
      while ((tm = tjRe.exec(block)) !== null) {
        pageText.push(decodePdfString(tm[1]))
      }
      const tjArrRe = /\[((?:[^\[\]\\]|\\.)*)\]\s*TJ/g
      while ((tm = tjArrRe.exec(block)) !== null) {
        const items = tm[1].match(/\(((?:[^()\\]|\\.)*)\)/g) || []
        pageText.push(items.map(i => decodePdfString(i.slice(1, -1))).join(""))
      }
    }
    if (pageText.length) pages.push(pageText.join(""))
  }
  return pages
}

agentTools.register({
  name: "file_view",
  description: `通用文件查看器 — 查看工作区/项目本地文件的内容 (文件编辑工作流)。

支持:
- 文本/代码/日志/数据文件: 分页按行返回 (带行号，便于 file_edit 定位修改)
- PDF: 提取文本内容 (扫描版/加密 PDF 无法提取；需要完整理解 PDF 版式/表格时请用 media 工具原生读取)
- 其他二进制: 明确拒绝 (视频/音频请用 media 工具)

参数:
- offset 从 1 开始的行号，默认 1 (仅文本文件)
- limit 每页行数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT} (仅文本文件)

查看完用 file_edit 修改，用 file_search 定位具体位置。`,
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "文件路径 (绝对路径，或相对 当前目录的相对路径)" },
      offset: { type: "number", description: "起始行号 (1-based)，默认 1，仅文本文件生效" },
      limit: { type: "number", description: `每页行数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}，仅文本文件生效` },
    },
    required: ["file"],
  },

  execute: async (args, ctx) => {
    const { file, offset, limit } = args
    if (!file) return "请提供文件路径 (file)"

    const filepath = resolvePath(file, ctx)

    let stat
    try {
      stat = await fs.stat(filepath)
    } catch (err) {
      return `文件不存在或不可读: ${err.message}`
    }
    if (!stat.isFile()) return `不是普通文件: ${filepath}`
    if (stat.size > MAX_FILE_BYTES) return `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`

    const buf = await fs.readFile(filepath)
    const head = buf.subarray(0, BINARY_CHECK_BYTES)

    // PDF → 文本提取
    if (head.toString("latin1").startsWith("%PDF-")) {
      const pages = extractPdfText(buf)
      const total = pages.join("\n\n")
      if (!total.trim()) {
        return `PDF 无法提取文本 (${filepath}) — 可能是扫描版(无文本层)或加密 PDF。如需内容，可用 bash 截图工具或手动处理。`
      }
      const truncated = total.length > MAX_PDF_CHARS ? total.slice(0, MAX_PDF_CHARS) + `\n...(已截断, 共 ${total.length} 字符, ${pages.length} 页)` : total
      return `PDF 文件: ${filepath} (${pages.length} 页, ${(buf.length / 1024).toFixed(1)}KB)\n\n${truncated}`
    }

    // 图片 → data URI 视觉输入
    try {
      const ft = await fileTypeFromBuffer(head)
      if (ft?.mime?.startsWith("image/")) {
        if (buf.length > MAX_IMAGE_BYTES) return `图片过大 (${(buf.length / 1024 / 1024).toFixed(1)}MB)，上限 5MB`
        let dims = ""
        try {
          const size = imageSize(buf)
          if (size?.width) dims = ` ${size.width}x${size.height}`
        } catch {}
        return `图片 (${ft.mime}${dims}, ${(buf.length / 1024).toFixed(1)}KB): ${filepath}\ndata:${ft.mime};base64,${buf.toString("base64")}`
      }
    } catch {}

    // 文本 → 分页 (带二进制检测)
    let content
    try {
      content = buf.toString("utf-8")
    } catch (err) {
      return `读取失败: ${err.message}`
    }
    if (head.includes(0)) {
      return `二进制文件 (${(buf.length / 1024).toFixed(1)}KB)，不支持的类型: ${filepath}`
    }

    const start = Math.max(Math.floor(Number(offset) || 1), 1)
    const pageSize = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT)
    const lines = content.split("\n")
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    const total = lines.length

    if (total === 0) return `文件为空: ${filepath}`

    const end = Math.min(start + pageSize - 1, total)
    if (start > total) return `起始行 ${start} 超出文件总行数 ${total} (文件: ${filepath})`

    const width = String(end).length
    const body = []
    for (let i = start - 1; i < end; i++) {
      body.push(`${String(i + 1).padStart(width)}: ${lines[i]}`)
    }

    const more = end < total ? `\n... (共 ${total} 行, 已显示 ${start}-${end} 行, 继续查看请设 offset=${end + 1})` : ""
    return `文件: ${filepath}\n共 ${total} 行, 显示 ${start}-${end} 行:\n\n${body.join("\n")}${more}`
  },
})
