import fs from "node:fs/promises"
import path from "node:path"
import { ulid } from "ulid"
import { convertOfficeDoc } from "../media/office.js"
import { extractTitle, fetchHttpDocument, htmlToMarkdown } from "../helpers/http-fetch.js"

const TEMP_DIR = path.resolve("data/aigc/knowledge/tmp")
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const MAX_TEMP_MS = 10 * 60 * 1000

/** Markdown 风格的文本格式：分块时按标题层级切分 */
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd"])
/** 纯文本格式：直接读取 */
const TEXT_EXTS = new Set(["txt", "log", "csv", "tsv", "json", "xml", "yaml", "yml", "ini", "toml", "conf", "sh", "bash", "zsh", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "go", "rs", "java", "c", "h", "cpp", "hpp", "cc", "cs", "swift", "kt", "kts", "php", "rb", "lua", "r", "scala", "dart", "sql", "vue", "svelte", "scss", "less", "css", "srt", "vtt"])
const OFFICE_EXTS = new Set(["docx", "xlsx", "xls"])

const MIME_BY_EXT = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "text/xml",
  html: "text/html",
  htm: "text/html",
  yaml: "text/plain",
  yml: "text/plain",
  docx: DOCX_MIME,
  xlsx: XLSX_MIME,
  xls: "application/vnd.ms-excel",
  pdf: "application/pdf",
}

/** 文件名清洗：只保留 basename，去掉控制字符与 Windows 非法字符 */
export function cleanFileName(name) {
  const base = path
    .basename(String(name || "").replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .trim()
  return base.slice(0, 200) || "未命名文档"
}

/** 二进制探测：前 4KB 出现 NUL 即视为二进制 */
function looksBinary(buffer) {
  const length = Math.min(buffer.length, 4096)
  for (let i = 0; i < length; i++) if (buffer[i] === 0) return true
  return false
}

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer).replace(/^﻿/, "")
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    try {
      return new TextDecoder("utf-16be").decode(buffer).replace(/^﻿/, "")
    } catch {
      return new TextDecoder("utf-8").decode(buffer).replace(/^﻿/, "")
    }
  }
  return new TextDecoder("utf-8").decode(buffer).replace(/^﻿/, "")
}

function titleFromName(name) {
  return path.parse(cleanFileName(name)).name || "未命名文档"
}

async function parseOffice(buffer, ext) {
  await fs.mkdir(TEMP_DIR, { recursive: true })
  const file = path.join(TEMP_DIR, `${ulid()}.${ext}`)
  await fs.writeFile(file, buffer)
  try {
    const result = await convertOfficeDoc(file, ext === "docx" ? DOCX_MIME : XLSX_MIME)
    if (!result?.text?.trim()) throw new Error("文档解析失败或内容为空")
    return result
  } finally {
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

/**
 * 文件缓冲 → 可检索文本。
 * 支持 Markdown / 纯文本 / HTML / DOCX / XLSX；PDF 暂不支持。
 * @returns {Promise<{ text: string, title: string, markdown: boolean, mime: string }>}
 */
export async function parseFile({ name, buffer, mime = "" } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("文件内容为空")
  const file = cleanFileName(name)
  const ext = path.extname(file).slice(1).toLowerCase()
  const title = titleFromName(file)
  const declaredMime = String(mime || "").toLowerCase()

  if (ext === "pdf" || declaredMime === "application/pdf") throw new Error("暂不支持 PDF 文档，请转换为 Markdown / DOCX 后导入")
  if (ext === "doc") throw new Error("暂不支持旧版 .doc，请另存为 .docx 后导入")

  const officeExt = ext === "docx" || declaredMime === DOCX_MIME ? "docx" : ext === "xlsx" || ext === "xls" || declaredMime === XLSX_MIME || declaredMime === "application/vnd.ms-excel" ? "xlsx" : ""
  if (OFFICE_EXTS.has(ext) || officeExt) {
    const parsed = await parseOffice(buffer, officeExt || ext)
    return { text: parsed.text, title, markdown: officeExt === "docx" || ext === "docx", mime: parsed.mime || MIME_BY_EXT[officeExt || ext] || "" }
  }

  if (ext === "html" || ext === "htm" || declaredMime === "text/html") {
    const raw = decodeText(buffer)
    const text = htmlToMarkdown(raw)
    if (!text.trim()) throw new Error("网页正文为空")
    return { text, title: extractTitle(raw) || title, markdown: true, mime: "text/markdown" }
  }

  if (!TEXT_EXTS.has(ext) && !MARKDOWN_EXTS.has(ext)) {
    if (looksBinary(buffer)) throw new Error(`不支持的文件格式: ${ext ? `.${ext}` : "未知"}`)
  }

  const text = decodeText(buffer)
  if (!text.trim()) throw new Error("文件内容为空")
  const markdown = MARKDOWN_EXTS.has(ext) || declaredMime === "text/markdown"
  return { text, title, markdown, mime: declaredMime && !declaredMime.includes("octet-stream") ? declaredMime : MIME_BY_EXT[ext] || "text/plain" }
}

/** 抓取网页正文；解析失败时抛出可读错误 */
export async function parseUrl(url, { signal } = {}) {
  const target = String(url || "").trim()
  if (!/^https?:\/\/[^\s]+$/i.test(target)) throw new Error("URL 必须以 http:// 或 https:// 开头")

  // 后台导入没有交互式重试机会：配置了全局代理时直接使用
  const result = await fetchHttpDocument(target, { signal, useProxy: true })
  if (/^(Invalid URL|Access to internal|Fetch failed|Web fetch failed|Unsupported content type|Extracted content is empty)/.test(result)) throw new Error(result)

  let title = ""
  let text = ""
  const web = /^<web_content>\r?\nTitle: ([\s\S]*?)\r?\nSource: [\s\S]*?\r?\n\r?\n([\s\S]*?)\r?\n<\/web_content>$/.exec(result)
  if (web) {
    title = web[1].trim()
    text = web[2]
  } else {
    const raw = /^<raw_content>\r?\nSource: [^\n]*\r?\nContent-Type: [^\n]*\r?\n\r?\n([\s\S]*?)\r?\n<\/raw_content>$/.exec(result)
    text = raw ? raw[1] : result
    try {
      title = new URL(target).hostname
    } catch {}
  }

  text = text.trim()
  if (!text) throw new Error("网页正文为空")
  return { text, title: title || target, markdown: true, mime: "text/markdown", source: target }
}

/** 清理过期的临时解析文件 */
export async function cleanStaleTempFiles() {
  let entries
  try {
    entries = await fs.readdir(TEMP_DIR, { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = Date.now() - MAX_TEMP_MS
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const file = path.join(TEMP_DIR, entry.name)
    try {
      const stat = await fs.stat(file)
      if (stat.mtimeMs < cutoff) await fs.rm(file, { force: true })
    } catch (err) {
      logger.debug(`清理知识库临时文件失败: ${err.message}`)
    }
  }
}
