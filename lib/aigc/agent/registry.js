import { ToolRegistry } from "../registry.js"

/** Agent 专用工具注册中心 */
export default new ToolRegistry({ toolNotFound: name => `Unknown agent tool: ${name}` })
