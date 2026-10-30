import { fetchBytes, fetchJSON, joinURL, saveAudio } from "../util.js"

/** 阿里云百炼 DashScope */
export default {
  label: "DashScope Qwen TTS",
  defaults: {
    base_url: "https://dashscope.aliyuncs.com/api/v1",
    model: "qwen-tts",
    voice: "Cherry",
    language_type: "auto",
    timeout_ms: 20_000,
  },
  ready: opts => !!opts.api_key,
  async tts(text, opts) {
    const model = String(opts.model || "").trim()
    if (!/^qwen/i.test(model) || !/tts/i.test(model)) throw new Error(`DashScope 目前仅支持 Qwen TTS 模型；CosyVoice 需要 WebSocket，暂未支持 (model: ${model || "未配置"})`)

    const input = { text, voice: opts.voice || "Cherry" }
    if (opts.language_type && opts.language_type !== "auto") input.language_type = opts.language_type

    const data = await fetchJSON(joinURL(opts.base_url, "/services/aigc/multimodal-generation/generation"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.api_key}`,
        "Content-Type": "application/json",
      },
      body: { model, input },
      timeoutMs: opts.timeout_ms,
    })

    if (data?.code || data?.message) throw new Error(`DashScope TTS 失败: ${data.message || data.code}`)
    const audio = data?.output?.audio
    if (audio?.data) return saveAudio(Buffer.from(audio.data, "base64"), "wav")
    if (audio?.url) return saveAudio(await fetchBytes(audio.url, { timeoutMs: opts.timeout_ms }), "wav")
    throw new Error("DashScope TTS 响应缺少音频数据")
  },
}
