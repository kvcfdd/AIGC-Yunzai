import tools from "./registry.js"
import vm from "node:vm"
import fs from "node:fs/promises"
import path from "node:path"
import cfg from "../../config/config.js"

// RunScriptTool — LLM 自主编写 JS 代码，沙箱执行
// 适用于确定性的多步数据处理流程
/** 沙箱中可调用的安全工具白名单 */
const SAFE_TOOLS = new Set(["search", "browse", "query", "fetch_media"])

/** 脚本执行超时 */
const SCRIPT_TIMEOUT_S = 60

/** 最大代码长度 */
const MAX_CODE_LENGTH = 32000

/** 子模型生成代码时的最大输出 token 数 */
const CODE_GEN_MAX_TOKENS = 65536

/** 从 LLM 响应中提取代码块） */
function extractCode(text) {
  if (!text) return ""
  const fence = text.match(/```(?:js|javascript)?\s*\n?([\s\S]*?)```/i)
  if (fence) return fence[1].trim()
  return text.trim()
}

/** 调用子模型生成 JS 代码 */
async function generateCode(spec, reason) {
  const model = cfg.aigc?.gemini?.secondary_model || cfg.aigc?.gemini?.model
  if (!model) throw new Error("未配置模型，无法生成代码")

  const systemPrompt = `你是一个 JavaScript 代码生成器。根据用户的自然语言描述，编写在特定沙箱环境中运行的 JS 代码。

沙箱可用 API:
- callTool(name, args) — 调用工具: search(搜索), browse(浏览网页), query(查询数据), fetch_media(获取媒体)
- fetch(url, options?) — HTTP 请求 (自动阻止内网访问)，返回 { status, headers, body }
- readFile(filename, encoding?) — 读取 data/aigc/tmp/ 下的文件，默认 utf-8
- writeFile(filename, content, encoding?) — 写入文件到 data/aigc/tmp/，encoding 可传 "base64" 写入二进制
- console.log(...) — 输出日志（会随结果返回给用户）

代码规则:
- 你会被包装为 async 函数体执行: (async () => { 你的代码 })()
- 使用 await 调用异步 API
- 使用 return 返回最终结果（字符串或可 JSON 化的对象）
- 禁止使用 require、import、process、fs 等 Node.js API
- 禁止使用 eval、Function 构造函数

请只输出可执行的 JavaScript 代码，不要输出解释、不要用 markdown 代码块包裹。`

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: spec + (reason ? `\n\n任务背景: ${reason}` : "") },
  ]

  const codeGenMaxTokens = cfg.aigc?.code_gen_max_tokens || CODE_GEN_MAX_TOKENS

  Bot.makeLog("info", `[RunScript] 子模型生成代码, spec="${spec.slice(0, 100)}${spec.length > 100 ? "..." : ""}"`)

  const res = await Bot.aigc.provider.chat(messages, {
    stateful: false,
    model,
    max_tokens: codeGenMaxTokens,
  })

  if (res.blocked) throw new Error(`代码生成被安全策略拦截: ${res.finishReason}`)

  const code = extractCode(res.content || "")
  if (!code) throw new Error("子模型未生成有效代码")

  Bot.makeLog("info", `[RunScript] 子模型生成代码 ${code.length} 字符`)
  return code
}

// 沙箱 API 实现
/**
 * 调用一个安全工具并返回原始结果字符串。
 * 沙箱代码通过此函数与 Bot 工具交互。
 */
async function callTool(name, args) {
  if (!SAFE_TOOLS.has(name)) {
    return `[错误] 工具 "${name}" 在沙箱中不可用。可用工具: ${[...SAFE_TOOLS].join(", ")}`
  }

  // 沙箱中没有 ctx，传入一个最小化的 ctx
  const ctx = { user_id: "__sandbox__" }

  const result = await tools.execute(name, args || {}, ctx)
  if (result.error) return `[工具错误] ${result.error}`
  return typeof result.result === "string" ? result.result : JSON.stringify(result.result)
}

/**
 * HTTP fetch 封装
 */
async function sandboxFetch(url, options = {}) {
  if (typeof url !== "string" || !/^https?:\/\/[^\s]+$/i.test(url)) {
    return "[错误] 无效的 URL"
  }

  // 基本内网防护
  const lower = url.toLowerCase()
  if (lower.includes("localhost") || lower.includes("127.0.0.1") || lower.includes("::1") || lower.includes("0.0.0.0")) {
    return "[错误] 禁止访问内网地址"
  }
  if (lower.includes("192.168.") || lower.includes("10.") || lower.includes("172.16.")) {
    return "[错误] 禁止访问内网地址"
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timeout)

    const body = await res.text()
    return JSON.stringify({
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: body.slice(0, 50000), // 截断过长响应
    })
  } catch (err) {
    return `[Fetch 错误] ${err.message}`
  }
}

/** 沙箱读文件 — 仅限 data/aigc/tmp/ 目录 */
async function sandboxReadFile(filename, encoding = "utf-8") {
  const basename = path.basename(filename)
  if (!basename || basename === ".." || basename.includes("/") || basename.includes("\\")) {
    return "[错误] 文件名无效"
  }
  const tmpDir = path.resolve("data/aigc/tmp")
  const filepath = path.join(tmpDir, basename)
  try {
    if (encoding === "base64") {
      const buf = await fs.readFile(filepath)
      return buf.toString("base64")
    }
    return await fs.readFile(filepath, "utf-8")
  } catch (err) {
    return `[读取失败] ${err.message}`
  }
}

/** 沙箱写文件 — 仅限 data/aigc/tmp/ 目录，支持文本和 base64 二进制 */
async function sandboxWriteFile(filename, content, encoding = "utf-8") {
  // 防御: 禁止路径穿越
  const basename = path.basename(filename)
  if (!basename || basename === ".." || basename.includes("/") || basename.includes("\\")) {
    return "[错误] 文件名无效，仅允许纯文件名 (如 report.md)"
  }
  if (basename.length > 100) {
    return "[错误] 文件名过长 (最大 100 字符)"
  }

  const tmpDir = path.resolve("data/aigc/tmp")
  await fs.mkdir(tmpDir, { recursive: true })
  const filepath = path.join(tmpDir, basename)

  if (encoding === "base64") {
    // 二进制内容: 解码 base64 → Buffer → 写入
    const buf = Buffer.from(String(content), "base64")
    await fs.writeFile(filepath, buf)
    return `文件已写入: ${filepath} (${(buf.length / 1024).toFixed(1)}KB, binary)`
  }

  const contentStr = typeof content === "string" ? content : JSON.stringify(content, null, 2)
  await fs.writeFile(filepath, contentStr, "utf-8")

  const size = Buffer.byteLength(contentStr, "utf-8")
  return `文件已写入: ${filepath} (${(size / 1024).toFixed(1)}KB)`
}

// 工具注册
tools.register({
  name: "run_script",
  description: `编写并执行 JavaScript 代码来完成复杂的数据处理任务。适用于需要循环、条件判断、批量操作的确定性流程。

两种使用模式:
1. code 模式 — 直接编写 JS 代码并执行 (适合简短脚本)
2. spec 模式 — 用自然语言描述需求，由子模型生成代码 (适合复杂脚本，不限输出长度)

沙箱中可用的 API:
- callTool(name, args) — 调用工具: search, browse, query, fetch_media
  例: callTool("search", { q: "AI新闻", type: "web", limit: 5 })
- fetch(url, options?) — HTTP 请求 (自动阻止内网)，返回 { status, headers, body }
- readFile(filename, encoding?) — 读 data/aigc/tmp/ 下的文件，默认 utf-8
  例: readFile("report.md")
- writeFile(filename, content, encoding?) — 写文件到 data/aigc/tmp/，返回路径
  encoding 默认 "utf-8"，传 "base64" 可写入二进制
  例: writeFile("report.md", markdownStr)
  例: writeFile("chart.png", base64Str, "base64")
- console.log(...) — 输出日志 (会随结果返回)

代码要求:
- 代码会被包装为 async 函数体执行: (async () => { 你的代码 })()
- 使用 await 调用异步 API
- 使用 return 返回最终结果（字符串或可JSON化的对象）
- 代码中不能使用 require、import、process、fs 等 Node.js API
- 最大 ${MAX_CODE_LENGTH} 字符，超时 ${SCRIPT_TIMEOUT_S} 秒

code 模式示例 — 搜索新闻并批量获取内容:
\`\`\`js
const results = await callTool("search", { q: "量子计算突破", type: "web", limit: 5 });
const urls = [...results.matchAll(/https?:\\/\\/[^\\s)\\]"']+/g)].map(m => m[0]).filter(Boolean);
const contents = [];
for (const url of urls.slice(0, 3)) {
  const content = await callTool("browse", { url });
  contents.push(content.slice(0, 1000));
}
return contents.join("\\n---\\n");
\`\`\`

spec 模式示例 — 同样的任务用 spec 描述:
spec: "搜索量子计算突破的新闻，浏览前3个结果的网页内容，返回摘要"`,

  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: `要执行的 JavaScript 代码 (async 函数体)。与 spec 二选一。简单脚本用 code，复杂脚本用 spec。`,
      },
      spec: {
        type: "string",
        description: `自然语言描述：需要什么代码、做什么事。会交由子模型 (${cfg.aigc?.gemini?.secondary_model || cfg.aigc?.gemini?.model || "secondary"}) 用高 token 上限生成代码后执行。与 code 二选一，优先用 spec（不受主模型输出 token 限制）。`,
      },
      reason: {
        type: "string",
        description: "简短说明这段代码要做什么 (用于审计日志)",
      },
    },
  },

  execute: async args => {
    let { code, spec, reason = "" } = args

    // spec 模式: 由子模型生成代码
    if (!code && spec) {
      try {
        code = await generateCode(spec, reason)
      } catch (err) {
        return `代码生成失败: ${err.message}`
      }
    }

    if (!code || typeof code !== "string") return "缺少参数: 请提供 code 或 spec"

    if (code.length > MAX_CODE_LENGTH) {
      return `代码过长 (${code.length} 字符)，最大允许 ${MAX_CODE_LENGTH} 字符。请精简代码或拆分为多个步骤。`
    }

    const source = spec ? "spec→子模型" : "LLM直接生成"
    const codePreview = code.length > 200 ? code.slice(0, 200) + "..." : code
    Bot.makeLog("info", `[RunScript] 执行代码 [${source}]${reason ? ` (${reason})` : ""}: ${codePreview}`)

    // 收集 console.log 输出
    const logs = []
    const sandboxConsole = {
      log: (...args) => {
        logs.push(args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "))
      },
      warn: (...args) => {
        logs.push("[WARN] " + args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "))
      },
      error: (...args) => {
        logs.push("[ERROR] " + args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "))
      },
    }

    // 构建沙箱上下文 — 只暴露白名单 API
    const context = vm.createContext({
      callTool,
      fetch: sandboxFetch,
      readFile: sandboxReadFile,
      writeFile: sandboxWriteFile,
      console: sandboxConsole,
      JSON,
      Math,
      Date,
      String,
      Number,
      Boolean,
      Array,
      Object,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      RegExp,
      Map,
      Set,
      Promise,
      Error,
      setTimeout: undefined,
      setInterval: undefined,
      setImmediate: undefined,
      require: undefined,
      process: undefined,
      global: undefined,
      globalThis: undefined,
      eval: undefined,
      Function: undefined,
    })

    // 包装为 async IIFE，runInContext 返回 Promise，外层 await 拿到结果
    const wrappedCode = `"use strict"; (async () => { ${code} })();`

    let script
    try {
      script = new vm.Script(wrappedCode, {
        filename: "run_script.js",
        lineOffset: 0,
        columnOffset: 0,
      })
    } catch (err) {
      return `代码语法错误: ${err.message}`
    }

    try {
      // runInContext 的 timeout 只限制同步执行；async 操作需 Promise.race 兜底
      const promise = script.runInContext(context, { displayErrors: true })
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`脚本执行超时 (${SCRIPT_TIMEOUT_S}秒)`), { code: "ERR_SCRIPT_EXECUTION_TIMEOUT" })), SCRIPT_TIMEOUT_S * 1000)
      })
      const result = await Promise.race([promise, timeout])
      clearTimeout(timer)

      // 构建返回结果
      const output = typeof result === "string" ? result : JSON.stringify(result, null, 2)

      const logSection = logs.length > 0 ? `\n\n[console 输出]\n${logs.join("\n")}` : ""

      if (output === undefined || output === "undefined") {
        return `脚本执行完毕 (无返回值)。${logSection}`
      }

      return output + logSection
    } catch (err) {
      const logSection = logs.length > 0 ? `\n\n[console 输出 (错误前)]\n${logs.join("\n")}` : ""

      if (err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        return `脚本执行超时 (${SCRIPT_TIMEOUT_S}秒)。请优化代码或拆分为多个步骤。${logSection}`
      }

      // 提取有意义的错误信息
      const errMsg = err.message || String(err)
      return `脚本执行错误: ${errMsg}${logSection}`
    }
  },
})
