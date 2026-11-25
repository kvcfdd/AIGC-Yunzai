import tools, { TOOL_DESC_CATALOG_MAX } from "../tool-registry.js"
import { xmlEscape } from "../../helpers/xml.js"
import { isMaster } from "../workspace.js"

function clip(text, max = TOOL_DESC_CATALOG_MAX) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

tools.register({
  name: "plugin_view",
  description: "查看某个插件提供的工具与技能列表",
  parameters: {
    type: "object",
    properties: {
      plugin: { type: "string", description: "插件名，如 music-plugin" },
    },
    required: ["plugin"],
  },
  execute: async (args, ctx) => {
    const name = String(args?.plugin ?? "").trim()
    if (!name) throw new Error("plugin 必填")

    const assets = ctx?.pluginAssets
    if (!assets) throw new Error("当前运行环境不支持插件视图")
    const plugin = assets.get(name)
    if (!plugin) {
      const names = assets.list().map(item => item.name)
      throw new Error(`未找到插件: ${name}${names.length ? `；可用插件: ${names.join(", ")}` : ""}`)
    }

    const source = `plugin:${name}`
    const master = isMaster(ctx)
    const toolList = (ctx?.tools?.listBySource?.(source) || []).filter(item => master || item.permission !== "bot_owner")
    const skillList = ((await ctx?.skills?.list?.()) || []).filter(item => item.source === source).sort((a, b) => a.name.localeCompare(b.name))

    const lines = [`<plugin name="${xmlEscape(name)}">`, `  <description>${xmlEscape(clip(plugin.description || name))}</description>`]
    if (toolList.length) {
      lines.push("  <tools>")
      for (const tool of toolList) lines.push(`    <tool name="${xmlEscape(tool.name)}">${xmlEscape(clip(tool.description))}</tool>`)
      lines.push("  </tools>")
    }
    if (skillList.length) {
      lines.push("  <skills>")
      for (const skill of skillList) lines.push(`    <skill name="${xmlEscape(skill.name)}">${xmlEscape(clip(skill.description, 1024))}</skill>`)
      lines.push("  </skills>")
    }
    if (!toolList.length && !skillList.length) lines.push("  <note>当前没有可用的工具或技能</note>")
    lines.push("</plugin>")
    return lines.join("\n")
  },
})
