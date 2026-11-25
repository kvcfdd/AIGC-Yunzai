import tools from "../tool-registry.js"
import cfg from "../../config.js"
import { findKb, hasChunks, search, formatSearchResults, resolveKnowledgeConfig } from "../../knowledge/index.js"

const MAX_TOP_K = 20

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

tools.register(
  {
    name: "kb_search",
    description: "搜索知识库，返回相关片段",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词或问题",
        },
        kb: {
          type: "string",
          description: "知识库名称或 ID，不填搜索全部",
        },
        top_k: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TOP_K,
          description: `返回片段数（1-${MAX_TOP_K}），默认按配置`,
        },
      },
      required: ["query"],
    },
    execute: async (args, ctx) => {
      const config = ctx?.config || cfg
      const kc = resolveKnowledgeConfig(config)
      if (!kc.enable) throw new Error("知识库未启用（aigc.knowledge.enable）")

      const query = String(args?.query || "").trim()
      if (!query) throw new Error("query is required")

      if (!hasChunks()) return "The knowledge base is empty. Ask the bot_owner to import documents first."

      let kbIds
      const key = String(args?.kb || "").trim()
      if (key) {
        const kb = findKb(key)
        if (!kb) throw new Error(`Unknown knowledge base: ${key}`)
        kbIds = [kb.id]
      }

      const topK = args?.top_k == null ? kc.topMFinal : clampInt(args.top_k, kc.topMFinal, 1, MAX_TOP_K)
      const results = await search(query, { config, kbIds, topK, signal: ctx?.signal })
      return formatSearchResults(results)
    },
  },
  {
    enabled: () => {
      const kc = resolveKnowledgeConfig(cfg)
      return kc.enable && kc.mode === "tool"
    },
  },
)
