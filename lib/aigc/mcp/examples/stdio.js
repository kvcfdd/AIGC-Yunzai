/*
 * MCP stdio 工具编写示例 — 子进程通信模式
 *
 * 【工作原理】
 *   Yunzai 通过 spawn() 拉起此脚本作为子进程，通过 stdin 发送 JSON-RPC 请求，
 *   从 stdout 读取 JSON-RPC 响应。每行一个 JSON 对象，以 \n 分隔（NDJSON）。
 *
 * 【适用场景】
 *   - 本地工具，无需网络配置
 *   - 一次性脚本，用完即销毁
 *   - 需要直接访问 Node.js API 或文件系统
 *
 * 【注册到 Yunzai】
 *   配置文件 config/config/aigc.yaml:
 *
 *     mcp:
 *       servers:
 *         - name: my-local-tools
 *           command: node
 *           args: ["./lib/aigc/mcp/examples/stdio.js"]
 *           timeout_ms: 30000     # 单次请求超时，可选，默认 30s
 *           env: {}               # 额外环境变量，可选
 *
 * 【MCP 协议握手流程】
 *   1. Yunzai → send initialize  → server 响应 protocolVersion + serverInfo
 *   2. Yunzai → notify initialized → server 收到，正式就绪（stdio 模式可忽略此步）
 *   3. Yunzai → send tools/list   → server 返回工具数组
 *   4. LLM 调用工具时 → send tools/call → server 执行并返回 content[]
 *
 * 【工具定义规范】
 *   每个工具必须有 name, description, inputSchema。inputSchema 遵循 JSON Schema。
 *   description 是给 LLM 看的，说清楚工具"是什么"即可，不需要过度编写使用规则。
 *
 * 【通信规范】
 *   - 请求和响应都必须是单行 JSON
 *   - 响应必须带与请求相同的 id
 *   - 通知类消息（method 以 "notifications/" 开头）不需要响应
 *   - 不要往 stdout 输出调试日志，统一走 stderr
 */

// import process from "node:process"

// // 工具定义
// const tools = [
//   {
//     name: "random_number",
//     description: "Generate a random integer in a given range.",
//     inputSchema: {
//       type: "object",
//       properties: {
//         min: { type: "number", description: "Lower bound (inclusive), default 0" },
//         max: { type: "number", description: "Upper bound (inclusive), default 100" },
//       },
//     },
//   },
//   {
//     name: "uuid",
//     description: "Generate a random UUID string.",
//     inputSchema: {
//       type: "object",
//       properties: {},
//     },
//   },
// ]

// // 路由表: method → handler(params)
// const handlers = {
//   // 握手第一步：协商协议版本，返回自身信息
//   initialize: () => ({
//     protocolVersion: "2025-11-25",
//     capabilities: {},
//     serverInfo: { name: "example-stdio", version: "1.0.0" },
//   }),

//   // 返回工具列表，Yunzai 会以 mcp_<server_name>_<tool_name> 格式注册
//   "tools/list": () => ({ tools }),

//   // 执行工具调用，需要根据 name 分发到具体逻辑
//   "tools/call": ({ name, arguments: args = {} }) => {
//     switch (name) {
//       case "random_number": {
//         const min = args.min ?? 0
//         const max = args.max ?? 100
//         const value = Math.floor(Math.random() * (max - min + 1)) + min
//         return { content: [{ type: "text", text: String(value) }] }
//       }
//       case "uuid":
//         return { content: [{ type: "text", text: crypto.randomUUID() }] }
//       default:
//         // isError: true 表示工具执行失败，Yunzai 会捕获并返回错误摘要给 LLM
//         return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] }
//     }
//   },
// }

// // 行缓冲读取
// // stdin 数据按 chunk 到达，需要自己分割 \n。不能依赖一行一个 chunk
// let buf = ""
// process.stdin.setEncoding("utf-8")
// process.stdin.on("data", chunk => {
//   buf += chunk
//   let idx
//   while ((idx = buf.indexOf("\n")) !== -1) {
//     const line = buf.slice(0, idx).trim()
//     buf = buf.slice(idx + 1)
//     if (!line) continue // 跳过空行

//     let msg
//     try { msg = JSON.parse(line) } catch { continue } // 忽略非 JSON 行

//     // 调试日志走 stderr，不要污染 stdout（stdout 只有 JSON-RPC 响应）
//     process.stderr.write(`[example-stdio] → ${msg.method}\n`)

//     const handler = handlers[msg.method]
//     if (!handler) {
//       respond(msg.id, { error: { code: -32601, message: `Method not found: ${msg.method}` } })
//       continue
//     }
//     // 支持同步和异步 handler
//     Promise.resolve(handler(msg.params ?? {}))
//       .then(result => respond(msg.id, { result }))
//       .catch(err => respond(msg.id, { error: { code: -32000, message: err.message } }))
//   }
// })

// // 响应写入
// // 通知类消息（notifications/*）不需要 id，也无需响应
// // JSON 内部不能有换行，否则破坏 NDJSON 帧
// function respond(id, payload) {
//   if (id === undefined || (typeof id === "string" && id.startsWith("notifications/"))) return
//   process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }).replace(/\n/g, "") + "\n")
// }
