import tools from "../tool-registry.js"
import { fetchWebDocument } from "../../helpers/doc-fetch.js"

tools.register({
  name: "web_fetch",
  description: `Fetch the text content of a specific HTTP(S) URL. The http mode is fast and does not run JavaScript; the playwright mode uses a headless browser for JS-rendered pages. Retry with playwright when http returns empty or incomplete content, and never invent page content when the fetch fails. Non-HTML responses are returned as raw text.`,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "HTTP(S) URL to fetch." },
      mode: {
        type: "string",
        enum: ["http", "playwright"],
        default: "http",
        description: "Fetch mode: http (fast, no JavaScript) or playwright (headless browser, slower).",
      },
      useProxy: {
        type: "boolean",
        description: "Use the configured proxy for blocked sites.",
      },
    },
    required: ["url"],
  },
  execute: async args => {
    const { url, mode = "http", useProxy = false } = args
    return fetchWebDocument(url, { mode, useProxy })
  },
})
