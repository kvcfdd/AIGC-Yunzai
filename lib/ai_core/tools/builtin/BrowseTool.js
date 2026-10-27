import tools from "../tool-registry.js"
import { fetchWebDocument } from "../../helpers/doc-fetch.js"

tools.register({
  name: "browse",
  description: `浏览指定网页获取正文 — 用于阅读 search 工具搜到的结果页面、访问用户提到的链接等。

行为说明:
- 直接返回网页正文（HTML 会先提取正文，超长内容按上限截断）
- 非 HTML 内容 (如 JSON/纯文本): 直接返回原文
- 被屏蔽或无法访问的网站 (如国内被墙的站点): 设置 useProxy: true 通过代理访问

示例:
- 浏览搜索结果页面: browse({ url: "https://example.com/article" })
- 通过代理访问被墙页面: browse({ url: "https://x.com/user/status/123", useProxy: true })`,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要浏览的网页 URL" },
      useProxy: {
        type: "boolean",
        description: "是否使用代理访问。国内被墙的网站设为 true，默认为 false",
      },
    },
    required: ["url"],
  },
  execute: async args => {
    const { url, useProxy = false } = args
    return fetchWebDocument(url, { useProxy })
  },
})
