import tools from "./registry.js"
import { pluginSkills } from "../skills/index.js"

tools.register({
  name: "skill",
  description: `查看插件技能 (plugins/*/SKILL.md) 的详细执行指引。

用法: 系统提示词中列有可用技能名称与描述,当用户请求与某技能相关时,先调用本工具读取该技能的正文,再按正文指引执行;执行过程中如需了解其他技能,可再次调用。

示例: skill({ skill_name: "技能名" })

提示: 技能正文可能包含工具使用说明、命令格式等关键信息,务必完整阅读后再执行。`,
  parameters: {
    type: "object",
    properties: {
      skill_name: { type: "string", description: "技能名称" },
    },
    required: ["skill_name"],
  },
  execute: async args => {
    const { skill_name } = args
    if (!skill_name) return "请提供技能名称 skill_name"

    const content = await pluginSkills.get(skill_name)
    if (content == null) {
      const names = (await pluginSkills.list()).map(i => i.name)
      return `未找到技能 ${skill_name}，可用技能: ${names.length ? names.join(", ") : "无"}`
    }
    return content
  },
})
