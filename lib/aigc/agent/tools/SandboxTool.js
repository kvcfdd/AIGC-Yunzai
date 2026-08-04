import agentTools from "../registry.js"
import vm from "node:vm"

const SCRIPT_TIMEOUT_S = 60
const MAX_CODE_LENGTH = 32000

agentTools.register({
  name: "sandbox",
  description: `在沙箱中执行 JavaScript 代码。沙箱提供以下 API:

- search({ q, type?, limit? }) — 搜索互联网
- browse({ url }) — 浏览网页
- media({ url, type? }) — 下载媒体文件
- workspace.read(filename, encoding?) — 读取工作区文件
- workspace.write(filename, content, encoding?) — 写入工作区文件
- workspace.list() — 列出工作区文件
- console.log(...) — 输出日志

代码要求: async 函数体，await 调用 API，return 返回结果。
最大 ${MAX_CODE_LENGTH} 字符，超时 ${SCRIPT_TIMEOUT_S} 秒。`,

  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "要执行的 JavaScript 代码 (async 函数体)" },
      reason: { type: "string", description: "简短用途说明" },
    },
    required: ["code"],
  },

  execute: async (args, ctx) => {
    const { code, reason = "" } = args
    if (!code || typeof code !== "string") return "缺少代码参数 (code)"
    if (code.length > MAX_CODE_LENGTH) return `代码过长 (${code.length} 字符)，最大 ${MAX_CODE_LENGTH} 字符`

    const codePreview = code.length > 200 ? code.slice(0, 200) + "..." : code
    Bot.makeLog("info", `[Agent-Sandbox] 执行代码${reason ? ` (${reason})` : ""}: ${codePreview}`)

    const logs = []
    const sandboxConsole = {
      log: (...a) => logs.push(a.map(x => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")),
      warn: (...a) => logs.push("[WARN] " + a.map(x => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")),
      error: (...a) => logs.push("[ERROR] " + a.map(x => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")),
    }

    const sandboxTools = {
      search: (q, opts) => {
        const args = typeof q === "object" ? q : { q, ...(opts || {}) }
        return agentTools.execute("search", args, ctx).then(r => (r.error ? `[错误] ${r.error}` : r.result))
      },
      browse: (url, opts) => {
        const args = typeof url === "object" ? url : { url, ...(opts || {}) }
        return agentTools.execute("browse", args, ctx).then(r => (r.error ? `[错误] ${r.error}` : r.result))
      },
      media: (url, opts) => {
        const args = typeof url === "object" ? url : { url, ...(opts || {}) }
        return agentTools.execute("media", args, ctx).then(r => (r.error ? `[错误] ${r.error}` : r.result))
      },
    }

    const sandboxWorkspace = {
      read: (filename, encoding) => ctx.workspace.readFile(filename, encoding),
      write: (filename, content, encoding) => ctx.workspace.writeFile(filename, content, encoding),
      list: () => ctx.workspace.listFiles(),
    }

    const sandboxFetch = async (url, options = {}) => {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        throw new Error("fetch 仅允许 http/https URL")
      }
      const res = await fetch(url, options)
      const text = await res.text()
      return { ok: res.ok, status: res.status, text: () => text, json: () => JSON.parse(text) }
    }

    const context = vm.createContext({
      search: sandboxTools.search,
      browse: sandboxTools.browse,
      media: sandboxTools.media,
      workspace: sandboxWorkspace,
      fetch: sandboxFetch,
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

    const wrappedCode = `"use strict"; (async () => { ${code} })();`

    let script
    try {
      script = new vm.Script(wrappedCode, { filename: "agent_sandbox.js" })
    } catch (err) {
      return `代码语法错误: ${err.message}`
    }

    try {
      const promise = script.runInContext(context, { displayErrors: true })
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`超时 (${SCRIPT_TIMEOUT_S}秒)`), { code: "ERR_SCRIPT_EXECUTION_TIMEOUT" })), SCRIPT_TIMEOUT_S * 1000)
      })
      const result = await Promise.race([promise, timeout])
      clearTimeout(timer)

      const output = typeof result === "string" ? result : JSON.stringify(result, null, 2)
      const logSection = logs.length > 0 ? `\n\n[console]\n${logs.join("\n")}` : ""

      if (output === undefined || output === "undefined") return `执行完毕 (无返回值)${logSection}`
      return output + logSection
    } catch (err) {
      const logSection = logs.length > 0 ? `\n\n[console (错误前)]\n${logs.join("\n")}` : ""
      if (err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return `超时 (${SCRIPT_TIMEOUT_S}秒)。请优化代码。${logSection}`
      return `执行错误: ${err.message || String(err)}${logSection}`
    }
  },
})
