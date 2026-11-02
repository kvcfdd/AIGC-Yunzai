import { GeminiAdapter } from "./gemini/adapter.js"
import { OpenAIAdapter } from "./openai/adapter.js"
import { AnthropicAdapter } from "./anthropic/adapter.js"
import { ResponsesAdapter } from "./responses/adapter.js"
import { resolveModelConfig } from "./model-config.js"
import { AigcError } from "./errors.js"
import { recordTokenUsage } from "./token-usage.js"

/** 请求适配器名 → 实现 */
const adapters = new Map([
  ["gemini", new GeminiAdapter()],
  ["openai", new OpenAIAdapter()],
  ["anthropic", new AnthropicAdapter()],
  ["responses", new ResponsesAdapter()],
])

export function supportedAdapters() {
  return [...adapters.keys()]
}

export function getProvider(adapterName = "gemini") {
  const adapter = adapters.get(adapterName)
  if (!adapter) throw new AigcError("UNSUPPORTED_ADAPTER", `不支持的请求适配器: ${adapterName}；当前支持: ${supportedAdapters().join(", ") || "无"}`)
  return adapter
}

/** Provider 路由 — 按 modelConfig.adapter 选择适配器 */
const provider = {
  async chat(messages, options = {}) {
    const modelConfig =
      options.modelConfig ||
      resolveModelConfig({
        model_config: options.model_config,
        adapter: options.adapter,
        max_output_tokens: options.max_output_tokens,
        retry_count: options.retry_count,
      })
    const res = await getProvider(modelConfig.adapter).chat(messages, { ...options, modelConfig })
    recordTokenUsage(res?.usage, options.channel)
    return res
  },
}

export { AigcError, resolveModelConfig }
export default provider
