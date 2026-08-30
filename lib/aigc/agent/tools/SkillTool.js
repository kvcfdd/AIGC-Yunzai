import agentTools from "../registry.js"
import log from "../../helpers/log.js"
import { agentSkills } from "../../skills/index.js"

agentTools.register({
  name: "skill",
  description: `查看 Agent 技能 (config/skills/*/SKILL.md) 的详细执行指引。

用法: 系统提示词中列有可用技能名称与描述,当任务与某技能相关时,先调用本工具读取该技能的正文,再按正文指引执行;执行过程中可再次调用查看其他技能。

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

    log.info(`[Agent-Skill] 查看技能: ${skill_name}`)
    const content = await agentSkills.get(skill_name)
    if (content == null) {
      const names = (await agentSkills.list()).map(i => i.name)
      return `未找到技能 ${skill_name}，可用技能: ${names.length ? names.join(", ") : "无"}`
    }
    return content
  },
})
