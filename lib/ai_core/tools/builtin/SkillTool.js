import path from "node:path"
import tools from "../tool-registry.js"

/** 技能目录 → 项目内相对路径（统一 / 分隔） */
function displayDir(dir) {
  const rel = path.relative(process.cwd(), dir)
  return (rel || ".").split(path.sep).join("/")
}

tools.register({
  name: "skill",
  description: `查看用户技能 (data/skills/<name>/SKILL.md) 的详细执行指引与技能目录文件列表。

用法: 系统提示词中列有可用技能名称与描述,当用户请求与某技能相关时,先调用本工具读取该技能的正文,再按正文指引执行;执行过程中如需了解其他技能,可再次调用。

返回内容: 技能正文、声明使用的工具、技能目录文件树。文件树中的脚本/参考资料可按相对路径使用其他工具读取。

示例: skill({ skill_name: "技能名" })

提示: 技能正文可能包含工具使用说明、命令格式等关键信息,务必完整阅读后再执行。`,
  parameters: {
    type: "object",
    properties: {
      skill_name: { type: "string", description: "技能名称" },
    },
    required: ["skill_name"],
  },
  execute: async (args, ctx) => {
    const { skill_name } = args
    if (!skill_name) return "请提供技能名称 skill_name"

    const skill = await ctx.skills.get(skill_name)
    if (!skill) {
      const names = (await ctx.skills.list()).map(i => i.name)
      return `未找到技能 ${skill_name}，可用技能: ${names.length ? names.join(", ") : "无"}`
    }

    const parts = [skill.content]
    if (skill.tools?.length) parts.push(`本技能声明使用的工具: ${skill.tools.join(", ")}`)
    parts.push(`技能目录: ${displayDir(skill.dir)}\n文件:\n${skill.files || "(空)"}`)
    return parts.join("\n\n")
  },
})
