/*
 * MCP HTTP 工具编写示例 — 独立 HTTP 服务模式
 *
 * 【工作原理】
 *   此脚本作为独立 HTTP 进程运行，监听 localhost:3000/mcp。
 *   Yunzai 通过 HTTP POST 发送 JSON-RPC 请求体，服务端返回 JSON-RPC 响应体。
 *   遵循 MCP Streamable HTTP 传输规范。
 *
 * 【适用场景】
 *   - 需要跨机器部署（Yunzai 和工具服务不在同一台机器）
 *   - 工具服务需要持久运行，被多个客户端共享
 *   - 已有 HTTP 服务，加一个 /mcp 端点即可接入
 *   - 语言无关 — 可以用 Python/Go/Rust 等任何语言实现
 *
 * 【启动方式】
 *   先启动服务:  node lib/aigc/mcp/examples/http.js
 *   再启动 Yunzai (或重启使其连接)
 *
 * 【注册到 Yunzai】
 *   配置文件 config/config/aigc.yaml:
 *
 *     mcp:
 *       servers:
 *         - name: my-http-tools
 *           transport: http
 *           url: http://localhost:3000/mcp
 *           api_key: "xxx"         # 可选，服务端校验用
 *           timeout_ms: 30000      # 单次请求超时，可选，默认 30s
 *
 * 【与 stdio 的区别】
 *   - 需要独立启动，不会随 Yunzai 自动拉起/销毁
 *   - 原生支持并发（每条 HTTP 请求独立处理）
 *   - 可以加认证、限流、日志等中间件
 *   - Yunzai 侧用 transport-http.js 处理通信，服务端只需标准 HTTP + JSON
 *
 * 【握手流程同 stdio 示例，不再赘述】
 */

// import http from "node:http"

// const PORT = 3000

// // 工具定义
// const tools = [
//   {
//     name: "datetime",
//     description: "Get current date and time for a given timezone.",
//     inputSchema: {
//       type: "object",
//       properties: {
//         timezone: {
//           type: "string",
//           description: "IANA timezone name, e.g. 'Asia/Shanghai', 'America/New_York'. Default: UTC.",
//         },
//       },
//     },
//   },
//   {
//     name: "calc",
//     description: "Evaluate a simple math expression.",
//     inputSchema: {
//       type: "object",
//       properties: {
//         expression: {
//           type: "string",
//           description: "Math expression with + - * / () . e.g. '(3 + 5) * 2'",
//         },
//       },
//       required: ["expression"],
//     },
//   },
// ]

// // 路由表
// function handle(reqBody) {
//   const { method, params = {} } = reqBody

//   switch (method) {
//     case "initialize":
//       return {
//         protocolVersion: "2025-11-25",
//         capabilities: {},
//         serverInfo: { name: "example-http", version: "1.0.0" },
//       }

//     case "tools/list":
//       return { tools }

//     case "tools/call": {
//       const { name, arguments: args = {} } = params
//       switch (name) {
//         case "calc": {
//           // 白名单过滤，只允许数字、运算符、括号、空格
//           const sanitized = args.expression.replace(/[^0-9+\-*/().%\s]/g, "")
//           if (!sanitized) return { isError: true, content: [{ type: "text", text: "Invalid expression" }] }
//           try {
//             const n = eval(sanitized)
//             return { content: [{ type: "text", text: String(n) }] }
//           } catch {
//             return { isError: true, content: [{ type: "text", text: "Expression error" }] }
//           }
//         }
//         case "datetime": {
//           const tz = args.timezone || "UTC"
//           const s = new Date().toLocaleString("zh-CN", { timeZone: tz, hour12: false })
//           return { content: [{ type: "text", text: `${tz}: ${s}` }] }
//         }
//         default:
//           return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] }
//       }
//     }

//     default:
//       return null
//   }
// }

// // HTTP 服务
// http.createServer((req, res) => {
//   // MCP 端点固定为 POST /mcp
//   if (req.url !== "/mcp" || req.method !== "POST") {
//     res.writeHead(404)
//     return res.end()
//   }

//   let body = ""
//   req.on("data", c => body += c)
//   req.on("end", () => {
//     let reqBody
//     try { reqBody = JSON.parse(body || "{}") } catch {
//       res.writeHead(400)
//       return res.end()
//     }

//     const { id } = reqBody
//     try {
//       const result = handle(reqBody)
//       if (!result) {
//         res.writeHead(404)
//         return res.end()
//       }
//       res.writeHead(200, { "Content-Type": "application/json" })
//       res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
//     } catch (err) {
//       res.writeHead(500, { "Content-Type": "application/json" })
//       res.end(JSON.stringify({
//         jsonrpc: "2.0", id,
//         error: { code: -32000, message: err.message },
//       }))
//     }
//   })
// }).listen(PORT, () => {
//   console.log(`MCP example-http listening on http://localhost:${PORT}/mcp`)
// })
