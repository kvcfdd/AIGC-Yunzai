import tools from "../tool-registry.js"
import { fetchWebDocument } from "../../helpers/doc-fetch.js"

tools.register({
  name: "web_fetch",
  description: "抓取网页文本内容",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "网页 URL" },
      mode: {
        type: "string",
        enum: ["http", "playwright"],
        default: "http",
        description: "http=快速抓取，playwright=浏览器渲染",
      },
      useProxy: {
        type: "boolean",
        description: "true=使用配置的代理",
      },
    },
    required: ["url"],
  },
  execute: async (args, ctx) => {
    const { url, mode = "http", useProxy = false } = args
    return fetchWebDocument(url, { mode, useProxy, signal: ctx?.signal })
  },
})
