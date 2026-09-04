import mammoth from "mammoth"
import XLSX from "xlsx"
import TurndownService from "turndown"
import log from "../helpers/log.js"

// OOXML 工作文档 mime → 本地预处理后以白名单格式发送
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/** 支持本地预处理的 OOXML mime 集合 */
export const OFFICE_MIMES = new Set([DOCX_MIME, XLSX_MIME])

// 转换文本产物上限，防超长表格/文档把请求撑爆；超出截断并标注
const MAX_OUT_CHARS = 500 * 1024
const TRUNCATED = "\n\n...（内容过长，已截断）"

// docx 抽出的 html 结构规整，turndown 转 Markdown
const md = (() => {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" })
  td.remove(["script", "style"])
  return td
})()

// mammoth 输出 <td> 内嵌 <p> 的无表头结构，且 rowspan/colspan 无法在 GFM 表达
// turndown 对无规则 table 原样泄漏 html，故先转 markdown 再对结果中的
// table html 片段做提取 —— 文本换行不被 HTML 解析折叠
function tableHtmlToMd(tableHtml) {
  const rows = []
  const trRe = /<tr[\s\S]*?<\/tr>/gi
  let tr
  while ((tr = trRe.exec(tableHtml))) {
    const cells = []
    const cellRe = /<t[dh][\s\S]*?<\/t[dh]>/gi
    let td
    while ((td = cellRe.exec(tr[0]))) {
      let text = td[0]
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\|/g, "\\|")
      cells.push(text || " ")
    }
    if (cells.length) rows.push(`| ${cells.join(" | ")} |`)
  }
  if (!rows.length) return ""
  // 首行作表头 + 分隔行
  const sep = rows[0].replace(/[^|]/g, "-")
  return `\n\n${rows[0]}\n${sep}\n${rows.slice(1).join("\n")}\n\n`
}

/** docx → Markdown 文本；图片/复杂版式丢弃
 *  表格在 turndown 前先从 html 摘出并替换为私用区字符占位，最后再换回 GFM 表格 */
async function docxToMarkdown(file) {
  const { value } = await mammoth.convertToHtml({ path: file })
  const tables = []
  const html = (value || "").replace(/<table[\s\S]*?<\/table>/gi, m => {
    const i = tables.push(m) - 1
    return `\n\ntbl${i}\n\n`
  })
  return md.turndown(html).replace(/tbl(\d+)/g, (_, i) => tableHtmlToMd(tables[Number(i)]))
}

/** xlsx → 各 sheet 分段 CSV 文本 */
function xlsxToCsv(file) {
  const wb = XLSX.readFile(file)
  const parts = []
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name])
    if (csv) parts.push(`[Sheet: ${name}]\n${csv}`)
  }
  return parts.join("\n\n") || "(空工作簿)"
}

/** 尝试本地预处理 OOXML 工作文档 → 白名单内文本格式。
 *  @param {string} file - 已落盘缓存的原始文件路径
 *  @param {string} mime - OFFICE_MIMES 内的 mime
 *  @returns {Promise<{ text: string, mime: string }|null>} 转换产物，失败返回 null */
export async function convertOfficeDoc(file, mime) {
  try {
    const isDocx = mime === DOCX_MIME
    const raw = isDocx ? await docxToMarkdown(file) : xlsxToCsv(file)
    const text = (raw || "").trim()
    if (!text) {
      log.debug(`文档转换结果为空: ${file}`)
      return null
    }
    const clipped = text.length > MAX_OUT_CHARS ? text.slice(0, MAX_OUT_CHARS) + TRUNCATED : text
    return { text: clipped, mime: isDocx ? "text/markdown" : "text/csv" }
  } catch (err) {
    log.warn(`文档本地转换失败 [${mime}]: ${err.message}`)
    return null
  }
}
