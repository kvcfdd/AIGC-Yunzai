import { getAigc } from "../config.js"
import { AigcError } from "./errors.js"

export const DEFAULT_ADAPTER = "gemini"

/**
 * 解析某个使用点选中的模型配置。
 *
 * selection: { model_config?, adapter?, max_output_tokens?, retry_count? }
 * model_config 优先级：使用点 > 全局 > 第一个模型配置
 * adapter 优先级：使用点 > 全局 > gemini（请求适配器，不在模型配置里写）
 */
export function resolveModelConfig(selection = {}, aigc = getAigc()) {
  if (typeof selection === "string") selection = { model_config: selection }
  selection ||= {}

  const configs = (Array.isArray(aigc.models) ? aigc.models : []).map((c, i) => ({ ...c, name: c?.name || c?.model || `model-${i + 1}` }))
  const name = selection.model_config || aigc.model_config || configs[0]?.name
  const modelConfig = configs.find(c => c.name === name)

  if (!modelConfig) {
    const available = configs.map(c => c.name)
    throw new AigcError("MODEL_CONFIG_NOT_FOUND", `未找到模型配置: ${name || "(未指定)"}${available.length ? `；可用: ${available.join(", ")}` : "；请先在 aigc.models 中添加配置"}`)
  }

  return {
    ...modelConfig,
    adapter: selection.adapter || aigc.adapter || DEFAULT_ADAPTER,
    max_output_tokens: selection.max_output_tokens ?? modelConfig.max_output_tokens ?? aigc.max_output_tokens ?? 65536,
    context_window: selection.context_window ?? modelConfig.context_window ?? aigc.context_window ?? 1_000_000,
    retry_count: selection.retry_count ?? modelConfig.retry_count ?? aigc.retry_count ?? 0,
  }
}
