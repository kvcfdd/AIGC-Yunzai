import agentTools from "../registry.js"
import { fetchAndSummarize } from "../../helpers/web-summary.js"
import log from "../../helpers/log.js"

agentTools.register({
  name: "fetch_doc",
  description: "抓取网页/文档并提取正文内容 (HTML → markdown)。HTML 页面会调起子模型按 prompt 提炼所需信息；非 HTML 内容(如 JSON)直接返回原文。适合阅读文章、文档、API 说明、搜索结果详情页，被屏蔽/无法访问的网站设 useProxy: true 走代理。",
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
    return fetchAndSummarize(url, { prompt, useProxy })
  },
})
