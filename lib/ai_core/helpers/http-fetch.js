import TurndownService from "turndown"
import log from "./log.js"
import { isHostnameSafe } from "./ssrf.js"
import { getDownloadProxyDispatcher } from "../llm/network-proxy.js"

const MAX_BYTES = 5_000_000
const MAX_CHARS = 100_000
const MAX_REDIRECTS = 5
const TIMEOUT_MS = 30_000
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

/** 纯 HTTP 抓取的 HTML → Markdown 转换器 */
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
})
turndown.remove(["head", "title", "meta", "link", "base", "script", "style", "noscript", "template", "iframe", "object", "embed"])
turndown.addRule("removeHiddenContent", {
  filter(node) {
    if (node?.hasAttribute?.("hidden")) return true
    if (node?.getAttribute?.("aria-hidden")?.toLowerCase() === "true") return true
    if (node?.nodeName === "INPUT" && node.getAttribute?.("type")?.toLowerCase() === "hidden") return true
    const declarations = node?.getAttribute?.("style")?.split(";") ?? []
    return declarations.some(declaration => {
      const separator = declaration.indexOf(":")
      if (separator === -1) return false
      const property = declaration.slice(0, separator).trim().toLowerCase()
      const value = declaration
        .slice(separator + 1)
        .trim()
        .toLowerCase()
        .replace(/\s*!important\s*$/, "")
      return (property === "display" && value === "none") || (property === "visibility" && (value === "hidden" || value === "collapse"))
    })
  },
  replacement: () => "",
})

/** 从 HTML 提取 <title> */
export function extractTitle(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return ""
  return match[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
}

/** HTML → Markdown */
export function htmlToMarkdown(html) {
  return turndown
    .turndown(String(html))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function charsetOf(contentType) {
  const match = /charset\s*=\s*"?([^";]+)/i.exec(contentType || "")
  return match ? match[1].trim() : "utf-8"
}

function decode(buffer, contentType) {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(buffer)
  } catch {
    return new TextDecoder().decode(buffer)
  }
}

function isHtmlType(contentType) {
  return /text\/html|application\/xhtml\+xml/i.test(contentType || "")
}

function isTextType(contentType) {
  return /^text\//i.test(contentType || "") || /application\/(json|xml|ld\+json)|[+/]xml\b/i.test(contentType || "")
}

/** 有界读取响应体，返回 { buffer, truncated } */
async function readBounded(res, maxBytes) {
  if (!res.body) {
    const buffer = new Uint8Array(await res.arrayBuffer())
    return { buffer: buffer.subarray(0, maxBytes), truncated: buffer.length > maxBytes }
  }

  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = maxBytes - total
    if (value.length >= remaining) {
      chunks.push(value.subarray(0, remaining))
      total += remaining
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    total += value.length
  }

  const buffer = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.length
  }
  return { buffer, truncated }
}

/**
 * 纯 HTTP 抓取：不使用浏览器，不执行 JS。
 * 返回与 Playwright 抓取一致的 <web_content>/<raw_content> 文本。
 */
export async function fetchHttpDocument(url, { useProxy = false, maxContentLength = MAX_CHARS } = {}) {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return "Invalid URL format"

  let current
  try {
    current = new URL(url)
  } catch {
    return "Invalid URL format"
  }
  if (!(await isHostnameSafe(current.hostname))) {
    log.warn(`拦截内网地址: ${current.hostname}`)
    return "Access to internal/private network addresses denied"
  }

  const dispatcher = useProxy ? getDownloadProxyDispatcher() : undefined
  const signal = AbortSignal.timeout(TIMEOUT_MS)

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        ...(dispatcher ? { dispatcher } : {}),
      })

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location")
        if (!location) return `Fetch failed: HTTP ${res.status}`
        if (hop === MAX_REDIRECTS) return "Fetch failed: too many redirects"

        const next = new URL(location, current)
        if (next.origin !== current.origin) return `Fetch failed: cross-origin redirect blocked (${next.origin})`
        if (!(await isHostnameSafe(next.hostname))) {
          log.warn(`拦截内网地址: ${next.hostname}`)
          return "Access to internal/private network addresses denied"
        }
        current = next
        continue
      }

      if (!res.ok) return `Fetch failed: HTTP ${res.status}`

      const contentType = (res.headers.get("content-type") || "").toLowerCase()
      const { buffer, truncated } = await readBounded(res, MAX_BYTES)
      const text = decode(buffer, contentType).slice(0, maxContentLength)

      if (isHtmlType(contentType) || (!contentType && text.trimStart().startsWith("<"))) {
        const markdown = htmlToMarkdown(text)
        if (!markdown) return "Extracted content is empty"
        const title = extractTitle(text) || current.hostname
        const note = truncated ? "\n\n...[Content truncated]" : ""
        log.debug("HTTP 抓取网页成功")
        return `<web_content>\nTitle: ${title}\nSource: ${current.href}\n\n${markdown}${note}\n</web_content>`
      }

      if (isTextType(contentType)) {
        if (!text.trim()) return "Extracted content is empty"
        return `<raw_content>\nSource: ${current.href}\nContent-Type: ${contentType || "unknown"}\n\n${text}\n</raw_content>`
      }

      return `Unsupported content type: ${contentType || "unknown"}`
    }
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return "Web fetch failed: Fetch timeout"
    log.error(`HTTP 抓取网页失败: ${err.message}`)
    return `Web fetch failed: ${err.message}`
  }

  return "Web fetch failed: too many redirects"
}
