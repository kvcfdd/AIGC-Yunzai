import wusound from "./providers/wusound.js"
import openai from "./providers/openai.js"
import gemini from "./providers/gemini.js"
import minimax from "./providers/minimax.js"
import elevenlabs from "./providers/elevenlabs.js"
import azure from "./providers/azure.js"
import volcengine from "./providers/volcengine.js"
import mimo from "./providers/mimo.js"
import fishaudio from "./providers/fishaudio.js"
import dashscope from "./providers/dashscope.js"

/** 服务商注册表 —— key 即 aigc.voice.provider 的取值 */
const PROVIDERS = Object.freeze({
  wusound,
  openai,
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

/** 当前选择的服务商名 */
export function providerName(vcfg = {}) {
  return String(vcfg.provider || "wusound")
    .trim()
    .toLowerCase()
}

/** 一层深合并：providers.<name>.headers/params 等对象与默认值合并 */
function mergeConfig(defaults, ...layers) {
  const out = { ...(defaults || {}) }
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer || {})) {
      const base = out[key]
      const bothObjects = value && typeof value === "object" && !Array.isArray(value) && base && typeof base === "object" && !Array.isArray(base)
      out[key] = bothObjects ? { ...base, ...value } : value
    }
  }
  return out
}

/** 合并服务商默认值与 providers.<name> 配置 */
export function resolveProviderConfig(name, vcfg = {}) {
  const provider = getProvider(name)
  if (!provider) return {}
  return mergeConfig(provider.defaults, vcfg.providers?.[name])
}

/** 当前配置是否具备调用条件 */
export function available(config) {
  const vcfg = config?.aigc?.voice || {}
  const name = providerName(vcfg)
  const provider = getProvider(name)
  if (!provider) return false
  try {
    return !!provider.ready(resolveProviderConfig(name, vcfg))
  } catch {
    return false
  }
}

/** 合成语音，返回音频 URL 或本地文件路径 */
export async function synthesize(text, config) {
  const input = String(text ?? "").trim()
  if (!input) throw new Error("语音合成文本不能为空")

  const vcfg = config?.aigc?.voice || {}
  const name = providerName(vcfg)
  const provider = getProvider(name)
  if (!provider) throw new Error(`未知语音合成服务商: ${name}；可选: ${listProviders().join(" / ")}`)

  const opts = resolveProviderConfig(name, vcfg)
  if (!provider.ready(opts)) throw new Error(`语音合成服务商 ${name} 未配置完整`)

  const result = await provider.tts(input, opts, { config })
  if (!result) throw new Error(`语音合成服务商 ${name} 未返回音频`)
  return result
}
