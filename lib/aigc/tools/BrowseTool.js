import tools from "./registry.js"
import { fetchWebDocument } from "../helpers/doc-fetch.js"
import { summarizeWebContent } from "../helpers/web-summary.js"

tools.register({
  name: "browse",
  description: "浏览指定网页获取内容。HTML 页面会调起子模型按 prompt 提炼所需信息；非 HTML 内容(如 JSON)直接返回原文。被屏蔽或无法访问的网站可设置 useProxy: true 通过代理访问。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要浏览的网页 URL" },
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
  execute: async args => {
    const { url, prompt, useProxy = false } = args
    const content = await fetchWebDocument(url, { useProxy })
    // 非 HTML 原始内容: 直接返回
    if (content.startsWith("<raw_content>")) return content
    // 错误信息: 直接返回
    if (!content.startsWith("<web_content>")) return content
    // HTML 页面: 调起子模型按 prompt 总结
    if (!prompt?.trim()) return content
    const summary = await summarizeWebContent(content, prompt)
    return summary
  },
})
