import wusound from "./providers/wusound.js"
import openai from "./providers/openai.js"
import deepseek from "./providers/deepseek.js"
import gemini from "./providers/gemini.js"
import minimax from "./providers/minimax.js"
import elevenlabs from "./providers/elevenlabs.js"
import azure from "./providers/azure.js"
import volcengine from "./providers/volcengine.js"
import mimo from "./providers/mimo.js"
import fishaudio from "./providers/fishaudio.js"
import dashscope from "./providers/dashscope.js"

/** 服务商注册表 —— key 即语音模型配置中 api 的取值 */
const PROVIDERS = Object.freeze({
  wusound,
  openai,
  deepseek,
  gemini,
  minimax,
  elevenlabs,
  azure,
  volcengine,
  mimo,
  fishaudio,
  dashscope,
})

export function listProviders() {
  return Object.keys(PROVIDERS)
}

export function getProvider(name) {
  return (
    PROVIDERS[
      String(name || "")
        .trim()
        .toLowerCase()
    ] || null
  )
}

const isObject = value => !!value && typeof value === "object" && !Array.isArray(value)

/** 语音模型配置列表 */
export function voiceModels(vcfg = {}) {
  return (Array.isArray(vcfg.models) ? vcfg.models : []).filter(isObject).map((item, index) => ({ ...item, name: item.name || item.model || `voice-${index + 1}` }))
}

/** 一层深合并：headers 等对象与默认值合并 */
function mergeConfig(defaults, layer) {
  const out = { ...(defaults || {}) }
  for (const [key, value] of Object.entries(layer || {})) {
    const base = out[key]
    const bothObjects = value && typeof value === "object" && !Array.isArray(value) && base && typeof base === "object" && !Array.isArray(base)
    out[key] = bothObjects ? { ...base, ...value } : value
  }
  return out
}

/**
 * 解析选中的语音模型配置
 * model_config 留空时取第一个语音模型
 */
export function resolveVoiceConfig(vcfg = {}) {
  const models = voiceModels(vcfg)
  const name = vcfg.model_config || models[0]?.name
  const model = models.find(item => item.name === name)

  if (!model) {
    const available = models.map(item => item.name)
    throw new Error(`未找到语音模型配置: ${name || "(未指定)"}${available.length ? `；可用: ${available.join(", ")}` : "；请先在 aigc.voice.models 中添加配置"}`)
  }

  const api = String(model.api || "")
    .trim()
    .toLowerCase()
  const provider = getProvider(api)
  if (!provider) throw new Error(`未知语音合成服务商: ${api || "(未指定)"}；可选: ${listProviders().join(" / ")}`)

  return { model, api, provider, opts: mergeConfig(provider.defaults, model) }
}

/** 当前配置是否具备调用条件 */
export function available(config) {
  try {
    const { provider, opts } = resolveVoiceConfig(config?.aigc?.voice || {})
    return !!provider.ready(opts)
  } catch {
    return false
  }
}

/** 合成语音，返回音频 URL 或本地文件路径 */
export async function synthesize(text, config) {
  const input = String(text ?? "").trim()
  if (!input) throw new Error("语音合成文本不能为空")

  const { api, provider, opts } = resolveVoiceConfig(config?.aigc?.voice || {})
  if (!provider.ready(opts)) throw new Error(`语音合成服务商 ${api} 未配置完整`)

  const result = await provider.tts(input, opts, { config })
  if (!result) throw new Error(`语音合成服务商 ${api} 未返回音频`)
  return result
}
