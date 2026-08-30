import tools from "./registry.js"
import { fetchAndSummarize } from "../helpers/web-summary.js"

tools.register({
  name: "browse",
  description: `浏览指定网页获取内容 — 用于阅读 search 工具搜到的结果页面、访问用户提到的链接等。

行为说明:
- HTML 页面: 会调起子模型按 prompt 提炼所需信息,请明确写出需要从页面获取哪些信息
- 非 HTML 内容 (如 JSON/纯文本): 直接返回原文
- 被屏蔽或无法访问的网站 (如国内被墙的站点): 设置 useProxy: true 通过代理访问

示例:
- 浏览搜索结果页面: browse({ url: "https://example.com/article", prompt: "提取文章的发布时间和主要观点" })
- 通过代理访问被墙页面: browse({ url: "https://x.com/user/status/123", prompt: "这条推文说了什么", useProxy: true })`,
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
    return fetchAndSummarize(url, { prompt, useProxy })
  },
})
