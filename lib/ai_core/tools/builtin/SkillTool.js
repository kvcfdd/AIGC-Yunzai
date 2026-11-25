import path from "node:path"
import tools from "../tool-registry.js"

/** 技能目录 → 项目内相对路径（统一 / 分隔） */
function displayDir(dir) {
  const rel = path.relative(process.cwd(), dir)
  return (rel || ".").split(path.sep).join("/")
}

tools.register({
  name: "skill",
  description: "加载技能正文与技能文件树",
  parameters: {
    type: "object",
    properties: {
      skill_name: { type: "string", description: "技能名" },
    },
    required: ["skill_name"],
  },
  execute: async (args, ctx) => {
    const { skill_name } = args
    if (!skill_name) return "Please provide skill_name."

    const skill = await ctx.skills.get(skill_name)
    if (!skill) {
      const names = (await ctx.skills.list()).map(i => i.name)
      return `Skill not found: ${skill_name}. Available skills: ${names.length ? names.join(", ") : "none"}`
    }

    const parts = [skill.content]
    if (skill.source) parts.push(`Skill source: ${skill.source}`)
    if (skill.tools?.length) parts.push(`Tools declared by this skill: ${skill.tools.join(", ")}`)
    parts.push(`Skill directory: ${displayDir(skill.dir)}\nFiles:\n${skill.files || "(empty)"}`)
    return parts.join("\n\n")
  },
})
