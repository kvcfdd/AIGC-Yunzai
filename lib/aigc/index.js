// 核心: LLM 对话引擎
import provider, { AigcError } from "./provider.js"
import conversation from "./conversation.js"

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
import "./tools/BlockTool.js"
import "./tools/FetchImageTool.js"

// MCP: 外部工具协议
import mcp from "./mcp/manager.js"

// 语音: TTS 标识与转换
import voice from "./voice/index.js"
import "./tools/VoiceTool.js"

export { provider, conversation, tools, mcp, voice, AigcError }
