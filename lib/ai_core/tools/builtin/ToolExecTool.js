import cfg from "../../config.js"
import { MEDIA_FIELDS, TOOL_CONTENT_MAX } from "../../memory/persist.js"
import tools, { isMasterOnlyTool, isToolEnabled } from "../tool-registry.js"
import { validateSchema } from "../schema-validate.js"
import { normalizeToolResult } from "../tool-result.js"
import { isMaster } from "../workspace.js"

const MAX_CALLS = 8
const MAX_RESULT_CHARS = 6000
const MAX_TOTAL_CHARS = TOOL_CONTENT_MAX - 300
const MAX_SCHEMA_CHARS = 2000
const MAX_ERROR_CHARS = 500
const DEFAULT_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 600_000

/** 带超时的 Promise；超时只影响等待方，不会取消原任务 */
function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 单次 tool_exec 的工具超时 */
function execTimeout(config) {
  const value = Number(config?.aigc?.tool_loading?.exec_timeout_ms)
  return Math.min(Math.max(Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

/** 参数规范化：兼容 provider 把 arguments 生成为 JSON 字符串的情况 */
function normalizeArguments(value) {
  if (value == null) return {}
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return {}
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error("arguments 不是合法 JSON")
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("arguments 必须是 JSON 对象")
    return parsed
  }
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("arguments 必须是 JSON 对象")
  return value
}

/** 媒体挂在 Symbol 上：不进入 JSON 文本，也不参与文本截断 */
const MEDIA = Symbol("tool_exec_media")

/** 从规范化结果中取出非空媒体字段 */
function pickMedia(normalized) {
  let media
  for (const key of MEDIA_FIELDS) {
    if (!normalized[key]?.length) continue
    media ||= {}
    media[key] = normalized[key]
  }
  return media
}

/** 汇总批量调用返回的媒体 */
function mergeMedia(results) {
  let media
  for (const item of results) {
    const one = item?.[MEDIA]
    if (!one) continue
    media ||= {}
    for (const key of MEDIA_FIELDS) {
      if (one[key]?.length) (media[key] ||= []).push(...one[key])
    }
  }
  return media
}

/** 截断长结果，保留尾部提示 */
function truncateText(text, max) {
  if (max <= 0) return ""
  if (text.length <= max) return text
  const marker = "\n...(结果已截断，请缩小范围或分页读取)..."
  if (max <= marker.length) return text.slice(0, max)
  return text.slice(0, max - marker.length) + marker
}

/** 结果总长超过工具消息上限时，逐步压缩，保证返回的仍是合法 JSON */
function fitResults(results) {
  let text = JSON.stringify({ results })
  if (text.length <= MAX_TOTAL_CHARS) return text

  for (const item of results) {
    if (typeof item.result === "string") item.result = truncateText(item.result, 800)
    if (typeof item.error === "string") item.error = truncateText(item.error, 300)
    delete item.schema
    item.truncated = true
  }
  text = JSON.stringify({ results })
  if (text.length <= MAX_TOTAL_CHARS) return text

  const compact = results.map(item => ({
    index: item.index,
    ...(item.call_id ? { call_id: item.call_id } : {}),
    name: item.name,
    ok: item.ok,
    ...(item.ok ? { result: truncateText(String(item.result ?? ""), 80) } : { error: truncateText(String(item.error ?? ""), 80) }),
    truncated: true,
  }))
  text = JSON.stringify({ results: compact, truncated: true })
  if (text.length <= MAX_TOTAL_CHARS) return text
  return JSON.stringify({ results: [{ index: 0, name: "tool_exec", ok: false, error: "结果过大，请减少批量调用后重试", truncated: true }] })
}

/** 执行单个工具调用，异常与超时都转成结果项 */
async function runCall(call, index, ctx, timeoutMs, resultMax) {
  const started = Date.now()
  const log = ctx?.logger || globalThis.logger
  const name = String(call?.name ?? "").trim()
  const callId = call?.call_id != null ? String(call.call_id) : undefined
  const base = { index, ...(callId ? { call_id: callId } : {}), name: name || "(empty)" }

  try {
    if (!name) throw new Error("工具名不能为空")
    const tool = tools.tools.get(name)
    if (!tool) throw new Error(`工具不存在: ${name}`)
    if (tools.isNative(name)) throw new Error(`${name} 是原生工具，请直接调用`)
    if (!isToolEnabled(tool)) throw new Error(`工具 ${name} 未开启`)
    if (isMasterOnlyTool(tool) && !isMaster(ctx)) throw new Error(`${name} 仅 master 可用`)

    const toolArgs = normalizeArguments(call?.arguments)
    const invalid = validateSchema(toolArgs, tool.parameters)
    if (invalid) {
      const schema = JSON.stringify(tool.parameters || {}).length <= MAX_SCHEMA_CHARS ? tool.parameters : undefined
      return { ...base, ok: false, error: invalid, ...(schema ? { schema } : {}) }
    }

    const result = await withTimeout(tools.execute(name, toolArgs, ctx), timeoutMs, `工具 ${name} 执行超时 (${timeoutMs}ms)`)
    if (result && "error" in result) {
      log?.warn?.(`tool_exec ${name} 失败: ${result.error}`)
      return { ...base, ok: false, error: truncateText(String(result.error), MAX_ERROR_CHARS) }
    }

    const normalized = result?.result == null ? { content: "" } : normalizeToolResult(result.result)
    const rawText = normalized.content
    const text = truncateText(rawText, resultMax)
    const media = pickMedia(normalized)
    log?.info?.(`tool_exec ${name} 完成 (${Date.now() - started}ms)`)
    const item = { ...base, ok: true, result: text, ...(text.length !== rawText.length ? { truncated: true } : {}) }
    if (media) item[MEDIA] = media
    return item
  } catch (err) {
    log?.warn?.(`tool_exec ${name || "(empty)"} 异常: ${err.message}`)
    return { ...base, ok: false, error: truncateText(String(err.message || err), MAX_ERROR_CHARS) }
  }
}

tools.register({
  name: "tool_exec",
  description: "Execute one or more deferred tools listed in <available_tools>. Calls run in parallel; dependent calls must be separate rounds. Arguments must match the tool's JSON Schema; call tool_view first if the schema is unknown.",
  parameters: {
    type: "object",
    properties: {
      calls: {
        type: "array",
        minItems: 1,
        maxItems: MAX_CALLS,
        description: "Deferred tool calls to execute in parallel.",
        items: {
          type: "object",
          properties: {
            call_id: { type: "string", description: "Optional caller-defined id echoed in the result." },
            name: { type: "string", description: "Deferred tool name from <available_tools>." },
            arguments: {
              type: "object",
              properties: {},
              description: "Arguments matching the schema returned by tool_view. A JSON string is also accepted.",
            },
          },
          required: ["name", "arguments"],
        },
      },
    },
    required: ["calls"],
  },
  execute: async (args, ctx) => {
    const calls = Array.isArray(args?.calls) ? args.calls : []
    if (!calls.length) throw new Error("calls 不能为空")
    if (calls.length > MAX_CALLS) throw new Error(`一次最多执行 ${MAX_CALLS} 个工具`)

    const timeoutMs = execTimeout(ctx?.config || cfg)
    const resultMax = Math.min(MAX_RESULT_CHARS, Math.max(1000, Math.floor(MAX_TOTAL_CHARS / calls.length)))
    const results = await Promise.all(calls.map((call, index) => runCall(call, index, ctx, timeoutMs, resultMax)))
    const text = fitResults(results)
    const media = mergeMedia(results)
    return media ? { text, ...media } : text
  },
})
