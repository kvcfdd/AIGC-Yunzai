import tools from "../tool-registry.js"
import { MASTER_ONLY_TOOLS, isMaster } from "../workspace.js"

const MAX_RESULTS = 8
const MAX_LISTED = 40

tools.register(
  {
    name: "tool_search",
    description: "Load tools that are not currently available (e.g. MCP integrations). Search by keywords or select:name1,name2; loaded tools become callable next round.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or select:name1,name2." },
      },
      required: ["query"],
    },
    execute: async (args, ctx) => {
      const query = String(args?.query || "").trim()
      if (!query) throw new Error("query must be a non-empty string")
      if (!ctx?.activeTools) throw new Error("tool_search is only available inside the tool loop")

      const visible = tool => isMaster(ctx) || !MASTER_ONLY_TOOLS.has(tool.name)
      const matches = tools.searchDeferred(query, { filter: visible, activeTools: ctx.activeTools, limit: MAX_RESULTS })

      if (!matches.length) {
        const available = tools.listDeferred(visible).map(tool => tool.name)
        if (!available.length) return "No on-demand tools are configured."
        const listed = available.slice(0, MAX_LISTED).join(", ")
        const suffix = available.length > MAX_LISTED ? `${listed} … (+${available.length - MAX_LISTED})` : listed
        return `No matching tools. Available on-demand tools: ${suffix}`
      }

      const lines = []
      for (const tool of matches) {
        ctx.activeTools.add(tool.name)
        const desc = String(tool.description || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200)
        lines.push(`- ${tool.name}${desc ? `: ${desc}` : ""}`)
      }
      return `Loaded ${matches.length} tool(s); available from the next round:\n${lines.join("\n")}`
    },
  },
  { enabled: () => tools.listDeferred().length > 0 },
)
