import { boolOr, extFromFormat, fetchBytes, joinURL, saveAudio } from "../util.js"

function optionalFloat(value, name) {
  if (value === "" || value == null) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name} 必须是 0-1 的数字`)
  return n
}

/** ElevenLabs —— POST /text-to-speech/:voice_id，返回音频字节 */
export default {
  label: "ElevenLabs TTS",
  defaults: {
    base_url: "https://api.elevenlabs.io/v1",
    voice_id: "JBFqnCBsd6RMkjVDRZzb",
    model: "eleven_multilingual_v2",
    output_format: "mp3_44100_128",
    stability: "",
    similarity_boost: "",
    style: "",
    use_speaker_boost: true,
    timeout_ms: 20_000,
  },
  ready: opts => !!opts.api_key,
  async tts(text, opts) {
    const outputFormat = String(opts.output_format || "mp3_44100_128").toLowerCase()
    if (/^(pcm|ulaw|alaw)/.test(outputFormat)) throw new Error("ElevenLabs 不支持裸 PCM 输出，请使用 mp3/wav/opus")

    const voiceSettings = {}
    const stability = optionalFloat(opts.stability, "stability")
    const similarity = optionalFloat(opts.similarity_boost, "similarity_boost")
    const style = optionalFloat(opts.style, "style")
    if (stability !== undefined) voiceSettings.stability = stability
    if (similarity !== undefined) voiceSettings.similarity_boost = similarity
    if (style !== undefined) voiceSettings.style = style
    voiceSettings.use_speaker_boost = boolOr(opts.use_speaker_boost, true)

    const url = `${joinURL(opts.base_url, `/text-to-speech/${encodeURIComponent(opts.voice_id)}`)}?output_format=${encodeURIComponent(outputFormat)}`
    const buf = await fetchBytes(url, {
      method: "POST",
      headers: {
        "xi-api-key": opts.api_key,
        "Content-Type": "application/json",
      },
      body: {
        text,
        model_id: opts.model,
        voice_settings: voiceSettings,
      },
      timeoutMs: opts.timeout_ms,
    })
    return saveAudio(buf, extFromFormat(outputFormat, "mp3"))
  },
}
