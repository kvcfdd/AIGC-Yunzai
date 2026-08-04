import agentTools from "../registry.js"
import cfg from "../../../config/config.js"

/** 从 LLM 响应中提取代码块 */
function extractCode(text) {
  if (!text) return ""
  const fence = text.match(/```(?:js|javascript)?\s*\n?([\s\S]*?)```/i)
  if (fence) return fence[1].trim()
  return text.trim()
}

agentTools.register({
  name: "code_gen",
  description: `用自然语言描述需求，由代码模型生成 JavaScript 代码。生成的代码可以在 sandbox 中执行。

适合的场景:
- 复杂的多步骤数据处理（搜索→筛选→提取→汇总）
- 需要循环、条件判断、批量操作的流程
- 生成文件内容写入工作区

注意: 此工具只生成代码不执行，请将生成的代码传入 sandbox 执行。`,

  parameters: {
    type: "object",
    properties: {
      spec: { type: "string", description: "自然语言描述：需要生成什么代码、做什么事情。越详细越好。" },
      reason: { type: "string", description: "简短说明用途（用于日志）" },
    },
    required: ["spec"],
  },

  execute: async (args, ctx) => {
    const { spec, reason = "" } = args
    const model = cfg.aigc?.agent?.model || cfg.aigc?.gemini?.model
    if (!model) return "未配置 Agent 模型，无法生成代码"

    const systemPrompt = `你是一个 JavaScript 代码生成器。编写可在沙箱环境中执行的 JS 代码。

沙箱可用 API:
- search({ q, type?, limit? }) — 搜索互联网
- browse({ url }) — 浏览网页内容
- media({ url, type? }) — 下载查看媒体文件
- workspace.read(filename, encoding?) — 读取工作区文件，默认 utf-8
- workspace.write(filename, content, encoding?) — 写入工作区文件，encoding 可传 "base64"
- workspace.list() — 列出工作区所有文件
- console.log(...) — 输出日志

代码将被包装为 async 函数体执行: (async () => { 你的代码 })()
使用 await 调用异步 API，return 返回最终结果。
禁止使用 require、import、process、eval、Function 等 Node.js API。

请只输出可执行的 JavaScript 代码，不要输出解释。`

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: spec + (reason ? `\n\n任务背景: ${reason}` : "") },
    ]

    Bot.makeLog("info", `[Agent-CodeGen] 生成代码, spec="${spec.slice(0, 100)}${spec.length > 100 ? "..." : ""}"`)

    const res = await Bot.aigc.provider.chat(messages, {
      stateful: false,
      model,
      max_tokens: cfg.aigc?.agent?.max_tokens || 65536,
    })

    if (res.blocked) return `代码生成被安全策略拦截: ${res.finishReason}`
    const code = extractCode(res.content || "")
    if (!code) return "代码模型未生成有效代码"
    Bot.makeLog("info", `[Agent-CodeGen] 生成 ${code.length} 字符代码`)
    return code
  },
})
