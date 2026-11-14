import { boolOr, fetchBytes, joinURL, saveAudio, wavFromPcm } from "../util.js"

/** DeepSeek TTS */
export default {
  label: "DeepSeek TTS",
  defaults: {
    base_url: "https://api.deepseek.com/v1",
    voice_id: "stella",
    format: "wav",
    filter_markdown: true,
    timeout_ms: 60_000,
  },
  ready: opts => !!opts.api_key,
  async tts(text, opts) {
    const format = String(opts.format || "wav").toLowerCase() === "pcm" ? "pcm" : "wav"
    const base = String(opts.base_url || "https://api.deepseek.com/v1").replace(/\/+$/, "")
    const url = /\/tools\/tts$/.test(base) ? base : joinURL(base, "/tools/tts")

    const buf = await fetchBytes(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.api_key}`,
        "Content-Type": "application/json",
      },
      body: {
        text,
        voice_id: opts.voice_id || "stella",
        format,
        filter_markdown: boolOr(opts.filter_markdown, true),
      },
      timeoutMs: opts.timeout_ms,
      proxy: opts.proxy,
    })

    if (format === "pcm") return saveAudio(wavFromPcm(buf, { sampleRate: 24000 }), "wav")
    return saveAudio(buf, "wav")
  },
}
