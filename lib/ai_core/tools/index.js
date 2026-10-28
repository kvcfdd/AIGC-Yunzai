import registry from "./tool-registry.js"
import mcp from "./mcp/manager.js"

// 内置工具 — 副作用导入，向 registry 注册
import "./builtin/WebSearchTool.js"
import "./builtin/WebFetchTool.js"
import "./builtin/FetchMediaTool.js"
import "./builtin/SendMediaTool.js"
import "./builtin/ReadTool.js"
import "./builtin/WriteTool.js"
import "./builtin/EditTool.js"
import "./builtin/GlobTool.js"
import "./builtin/GrepTool.js"
import "./builtin/ShellTool.js"
import "./builtin/SkillTool.js"

export { registry, mcp }
export default registry
