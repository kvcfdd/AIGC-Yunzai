// 核心: LLM 对话引擎
import provider, { AigcError } from "./provider.js"
import conversation from "./conversation.js"
import memory from "./memory.js"
import knowledge from "./knowledge.js"

// 工具: Agent 工具集
import tools from "./tools/registry.js"
import "./tools/SearchTool.js"
import "./tools/BrowseTool.js"
import "./tools/ImageTool.js"
import "./tools/MediaTool.js"
import "./tools/RenderTool.js"
import "./tools/QueryTool.js"
import "./tools/GroupTool.js"
import "./tools/InteractTool.js"
import "./tools/MemoryTool.js"
import "./tools/BlockTool.js"
import "./tools/FetchImageTool.js"

// MCP: 外部工具协议
import mcp from "./mcp/manager.js"

// PCP: 插件能力协议 - 本地插件功能自动暴露为 LLM 工具
import pcp from "./pcp/index.js"

// 语音: TTS 标识与转换
import voice from "./voice/index.js"
import "./tools/VoiceTool.js"

export { provider, conversation, memory, knowledge, tools, mcp, pcp, voice, AigcError }
