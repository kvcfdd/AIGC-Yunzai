// 核心: LLM 对话引擎
import provider, { AigcError } from "./provider.js"
import conversation from "./conversation.js"

// 工具: Agent 工具集
import tools from "./tools/registry.js"
import "./tools/SearchTool.js"
import "./tools/BrowseTool.js"
import "./tools/RenderTool.js"
import "./tools/QueryTool.js"
import "./tools/GroupTool.js"
import "./tools/InteractTool.js"
import "./tools/BlockTool.js"
import "./tools/FetchImageTool.js"
import "./tools/ScheduleTaskTool.js"
import "./tools/AgentTool.js"
import "./tools/FileTool.js"

// MCP: 外部工具协议
import mcp from "./mcp/manager.js"

// 语音: TTS 标识与转换
import voice from "./voice/index.js"

// Agent: 后台任务子架构
import agent from "./agent/index.js"

/**
 * 合成消息注入原语 — 让后台任务能唤醒 LLM 继续对话。
 *
 * 调用方式：
 *   Bot.aigc.injectMessage({
 *     self_id: "机器人QQ",
 *     user_id: "目标用户QQ",
 *     group_id: "群号（可选）",
 *     text:    "注入的合成消息文本",
 *   })
 *
 * 这条消息会被推入正常的 AIGC 对话流程，效果等同于用户发了一条消息，
 * 但会跳过 @检测、冷却等用户侧限制。
 *
 * 实现由 plugins/system/aigc.js 在插件加载时注册。
 *
 * @param {{ self_id: string, user_id: string, group_id?: string, text: string }} params
 * @returns {Promise<any>} 对话流程的结果
 */
function injectMessage(params) {
  if (typeof injectMessage._impl !== "function") {
    throw new Error("AIGC 插件尚未加载，injectMessage 不可用")
  }
  return injectMessage._impl(params)
}
injectMessage._impl = null

export { provider, conversation, tools, mcp, voice, agent, AigcError, injectMessage }
