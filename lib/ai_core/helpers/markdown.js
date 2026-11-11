import TurndownService from "turndown"

/** 纯 HTML → Markdown 转换器（不依赖网络栈，抓取与本地文件解析共用） */
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

/** HTML → Markdown */
export function htmlToMarkdown(html) {
  return turndown
    .turndown(String(html))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
