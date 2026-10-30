import { extFromFormat, fetchJSON, saveAudio } from "../util.js"

function styleTag(prompt, dialect) {
  const style = [prompt, dialect]
    .map(text => String(text || "").trim())
    .filter(Boolean)
    .join(" ")
    .trim()
  if (!style) return ""
  if (style.includes("唱歌")) return "<style>唱歌</style>"
  return `<style>${style}</style>`
}

/** MiMo TTS —— OpenAI 风格 chat/completions，音频以 base64 返回 */
export default {
  label: "MiMo TTS",
  defaults: {
    base_url: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5-tts",
    voice: "mimo_default",
    format: "wav",
    style_prompt: "",
    dialect: "",
    seed_text: "Hello, MiMo, have you had lunch?",
    timeout_ms: 20_000,
  },
  ready: opts => !!opts.api_key,
  async tts(text, opts) {
    const base = String(opts.base_url || "").replace(/\/+$/, "")
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`
    const messages = []
    const seed = String(opts.seed_text || "").trim()
    if (seed) messages.push({ role: "user", content: seed })
    messages.push({ role: "assistant", content: `${styleTag(opts.style_prompt, opts.dialect)}${text}` })

    const audio = { format: opts.format || "wav" }
    // voice design 模型不支持 audio.voice 参数
    if (!String(opts.model || "").includes("voicedesign")) audio.voice = opts.voice

    const data = await fetchJSON(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.api_key}`,
        "Content-Type": "application/json",
      },
      body: { model: opts.model, messages, audio },
      timeoutMs: opts.timeout_ms,
    })

    const b64 = data?.choices?.[0]?.message?.audio?.data
    if (!b64) throw new Error("MiMo TTS 响应缺少音频数据")
    return saveAudio(Buffer.from(b64, "base64"), extFromFormat(opts.format, "wav"))
  },
}
