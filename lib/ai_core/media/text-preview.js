import { open, stat } from "node:fs/promises"
import path from "node:path"
import { htmlToMarkdown } from "../helpers/markdown.js"

/** 文本文件内联上限：字节与字符双限，谁先到算谁（中文 3 字节/字，纯 ASCII 约 1 字节/字） */
export const MAX_TEXT_BYTES = 50 * 1024
export const MAX_TEXT_CHARS = 20_000
/** HTML 先按较大体积解析，再截提取后的正文：10KB 原文可能连 <body> 都还没开始 */
export const MAX_HTML_PARSE_BYTES = 200 * 1024
export const MAX_HTML_CHARS = 10_000

const HTML_MIME = /^text\/html|^application\/xhtml\+xml/i
const HTML_EXT = /\.(?:html?|xhtml)$/i
const TEXT_MIME = /^text\//i
const TEXT_APP_MIME = /^application\/(?:json|ld\+json|xml|javascript|ecmascript|x-sh|x-yaml|yaml|toml|sql|graphql)/i
const TEXT_EXT = /\.(?:txt|text|md|markdown|mdx|log|out|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|conf|cfg|properties|env|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|lua|pl|sh|bash|zsh|ps1|bat|sql|css|scss|sass|less|xml|diff|patch)$/i
const TEXT_BASENAME = /^(?:dockerfile|makefile|readme|license|changelog|authors|notice|cargo\.lock|go\.mod)$/i

/** HTML 正文里常见的"不是内容"的区块 */
const HTML_BOILERPLATE = /<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi

/**
 * 判断文件该按文本还是 HTML 内联
 *
 * @param {string} [mime] 缓存文件解析出的 MIME
 * @param {string} [name] 原始或缓存文件名
 * @returns {"html"|"text"|null} null 表示不是文本类，调用方按原样内联
 */
export function textFileKind(mime, name = "") {
  const m = String(mime || "").toLowerCase()
  const n = String(name || "")
  if (HTML_MIME.test(m) || HTML_EXT.test(n)) return "html"
  if (TEXT_MIME.test(m) || TEXT_APP_MIME.test(m)) return "text"
  if (TEXT_EXT.test(n) || TEXT_BASENAME.test(path.basename(n))) return "text"
  return null
}

/** 只读文件头部 maxBytes 字节，避免大文件整读进内存 */
async function readPrefix(file, maxBytes) {
  const handle = await open(file, "r")
  try {
    const buf = Buffer.allocUnsafe(maxBytes)
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** 截字节必然切坏 UTF-8 尾巴，解码后去掉末尾的替换字符 */
function decodePrefix(buf) {
  const text = new TextDecoder("utf-8").decode(buf)
  return buf.length && buf[buf.length - 1] > 0x7f ? text.replace(/\uFFFD+$/, "") : text
}

function sizeLabel(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024).toFixed(1)}KB`
}

function truncationNotice(file, total, parts) {
  return `\n\n---\n[内容已截断] ${parts.join("，")}。文件共 ${sizeLabel(total)}，完整路径: ${file}。需要后续内容请用 read 工具按 offset/limit 分段读取。`
}

/**
 * 文本/HTML 文件 → 截断后的纯文本 data URI
 *
 * 非文本类返回 null，由调用方按原样 base64 内联（PDF / OOXML 等仍需原文件）。
 * 超限不拒绝，只截断并显式标注，模型可凭路径自己续读。
 *
 * @param {string} file 本地缓存文件路径
 * @param {string} [mime] MIME
 * @param {string} [name] 原始文件名
 * @returns {Promise<string|null>} data URI 或 null
 */
export async function textFileDataUri(file, mime, name = "") {
  const kind = textFileKind(mime, name || path.basename(file))
  if (!kind) return null

  const { size: total } = await stat(file)
  const notes = []
  let text
  let outMime

  if (kind === "html") {
    const buf = await readPrefix(file, MAX_HTML_PARSE_BYTES)
    if (total > MAX_HTML_PARSE_BYTES) notes.push(`仅解析了前 ${sizeLabel(MAX_HTML_PARSE_BYTES)} 源码`)
    const html = decodePrefix(buf).replace(HTML_BOILERPLATE, " ")
    let markdown = ""
    try {
      markdown = htmlToMarkdown(html)
    } catch {
      markdown = html.replace(/<[^>]+>/g, " ")
    }
    if (markdown.length > MAX_HTML_CHARS) {
      markdown = markdown.slice(0, MAX_HTML_CHARS)
      notes.push(`正文仅保留前 ${MAX_HTML_CHARS} 字符`)
    }
    text = markdown
    outMime = "text/markdown"
  } else {
    const buf = await readPrefix(file, MAX_TEXT_BYTES)
    if (total > MAX_TEXT_BYTES) notes.push(`仅读取了前 ${sizeLabel(MAX_TEXT_BYTES)}`)
    text = decodePrefix(buf)
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS)
      notes.push(`仅保留前 ${MAX_TEXT_CHARS} 字符`)
    }
    outMime = TEXT_MIME.test(String(mime || "")) ? String(mime).toLowerCase() : "text/plain"
  }

  if (notes.length) text += truncationNotice(file, total, notes)
  return `data:${outMime};base64,${Buffer.from(text, "utf8").toString("base64")}`
}
