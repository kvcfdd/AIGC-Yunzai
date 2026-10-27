import { GeminiAdapter } from "./gemini/adapter.js"
import { OpenAIAdapter } from "./openai/adapter.js"
import { AnthropicAdapter } from "./anthropic/adapter.js"
import { ResponsesAdapter } from "./responses/adapter.js"
import { resolveModelConfig } from "./model-config.js"
import { AigcError } from "./errors.js"

/** API 模式 → 适配器 */
const adapters = new Map([
  ["gemini", new GeminiAdapter()],
  ["openai", new OpenAIAdapter()],
  ["anthropic", new AnthropicAdapter()],
  ["responses", new ResponsesAdapter()],
])

export function supportedApis() {
  return [...adapters.keys()]
}

export function getProvider(api = "gemini") {
  const adapter = adapters.get(api)
  if (!adapter) throw new AigcError("UNSUPPORTED_API", `不支持的 API: ${api}；当前支持: ${supportedApis().join(", ") || "无"}`)
  return adapter
}

/** Provider 路由 — 按 modelConfig.api 选择适配器 */
const provider = {
  chat(messages, options = {}) {
    const modelConfig =
      options.modelConfig ||
      resolveModelConfig({
        model_config: options.model_config,
        api: options.api,
        max_output_tokens: options.max_output_tokens,
        retry_count: options.retry_count,
      })
    return getProvider(modelConfig.api).chat(messages, { ...options, modelConfig })
  },
}

export { AigcError, resolveModelConfig }
export default provider
