import tools from "./registry.js"
import { fetchWebDocument } from "../helpers/doc-fetch.js"

tools.register({
  name: "browse",
  description: "浏览指定网页，获取页面正文内容。被屏蔽或无法访问的网站可设置 useProxy: true 通过代理访问。",
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
