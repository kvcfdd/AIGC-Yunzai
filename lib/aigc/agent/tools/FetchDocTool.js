import agentTools from "../registry.js"
import { fetchAndSummarize } from "../../helpers/web-summary.js"
import log from "../../helpers/log.js"

const TEXT_HEAD = 100000
const TEXT_TAIL = 300

function truncateText(text) {
  if (text.length <= TEXT_HEAD + TEXT_TAIL) return text
  return text.slice(0, TEXT_HEAD) + `\n...[${text.length - TEXT_HEAD - TEXT_TAIL} 字符已省略, 共 ${text.length} 字符]` + text.slice(-TEXT_TAIL)
}

agentTools.register({
  name: "fetch_doc",
  description: "抓取网页/文档并提取正文(本工具仅用于同类工具兜底)。HTML 页面按 prompt 提炼所需信息；非 HTML 内容直接返回原文。无法访问的网站设 useProxy: true 走代理。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要抓取的网页 URL" },
      prompt: {
        type: "string",
        description: "想从页面了解的信息描述。HTML 页面会基于该描述进行总结提炼，请明确写出需要哪些信息",
      },
      useProxy: {
        type: "boolean",
        description: "是否使用代理访问。国内被墙的网站设为 true，默认为 false",
      },
    },
    required: ["url", "prompt"],
  },

  execute: async (args, ctx) => {
    const { url, prompt, useProxy = false } = args
    if (!url) return "请提供 URL"

    log.info(`[Agent-FetchDoc] 抓取: ${url.slice(0, 120)}`)
    const result = await fetchAndSummarize(url, { prompt, useProxy })
    return truncateText(typeof result === "string" ? result : String(result))
  },
})
