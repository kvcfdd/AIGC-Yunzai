import agentTools from "../registry.js"
import log from "../../helpers/log.js"
import { searchKnowledge, loadKnowledgeIndex } from "../workspace.js"

agentTools.register({
  name: "knowledge",
  description: `查看全局避坑指南 knowledge.md(项目根目录)中与主题相关的条目正文。

用法: 系统提示词的 <knowledge_index> 中列出了已有条目的标题与摘要, 当任务涉及其中某个主题(或遇到与本地环境/命令相关的报错)时, 调用本工具获取该主题的完整避坑正文后再执行; 可多次调用查看不同主题。

示例: knowledge({ topic: "python-pptx 字体" })

提示: 知识库由历次任务的踩坑经验沉淀而成, 主要涉及系统环境层面(命令报错、依赖问题等), 与具体任务无关; 同主题内容优先更新已有条目而非新增重复。`,
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string", description: "要查询的主题关键词, 会匹配条目标题/摘要/正文" },
    },
    required: ["topic"],
  },
  execute: async args => {
    const { topic } = args
    if (!topic) return "请提供查询主题 topic"

    log.info(`[Agent-Knowledge] 查询避坑: ${topic}`)
    const content = await searchKnowledge(topic)
    if (content != null) return content

    const index = await loadKnowledgeIndex()
    return `未找到与 "${topic}" 相关的条目，现有知识: ${index ? index.replace(/\n/g, "; ") : "无"}`
  },
})
