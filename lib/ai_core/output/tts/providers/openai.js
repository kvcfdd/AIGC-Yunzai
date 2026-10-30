import { extFromFormat, fetchBytes, joinURL, numberOr, saveAudio, wavFromPcm } from "../util.js"

/** OpenAI 兼容的 /audio/speech 接口，覆盖官方与第三方兼容服务 */
export default {
  label: "OpenAI TTS",
  defaults: {
    base_url: "https://api.openai.com/v1",
    model: "tts-1",
    voice: "alloy",
    response_format: "wav",
    speed: 1,
    headers: {},
    timeout_ms: 20_000,
  },
  ready: opts => !!opts.api_key,
  async tts(text, opts) {
    const format = String(opts.response_format || "wav").toLowerCase()
    const body = {
      model: opts.model,
      input: text,
      voice: opts.voice,
      response_format: format,
    }
    const speed = numberOr(opts.speed, 1)
    if (speed !== 1) body.speed = speed

    const buf = await fetchBytes(joinURL(opts.base_url, "/audio/speech"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.api_key}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
      body,
      timeoutMs: opts.timeout_ms,
    })

    // OpenAI 的 pcm 是 24kHz/16bit/单声道裸流，补 WAV 头后才能直接发送
    if (format === "pcm") return saveAudio(wavFromPcm(buf), "wav")
    return saveAudio(buf, extFromFormat(format, "mp3"))
  },
}
