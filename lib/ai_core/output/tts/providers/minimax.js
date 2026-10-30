import { extFromFormat, fetchJSON, joinURL, numberOr, saveAudio } from "../util.js"

/** MiniMax T2A v2 —— 非流式请求，data.audio 为十六进制音频 */
export default {
  label: "MiniMax TTS",
  defaults: {
    base_url: "https://api.minimax.chat/v1/t2a_v2",
    group_id: "",
    model: "speech-02-turbo",
    voice_id: "female-shaonv",
    speed: 1,
    vol: 1,
    pitch: 0,
    emotion: "auto",
    language_boost: "auto",
    format: "wav",
    sample_rate: 32000,
    bitrate: 128000,
    timeout_ms: 60_000,
  },
  ready: opts => !!opts.api_key,
  async tts(text, opts) {
    const voiceSetting = {
      speed: numberOr(opts.speed, 1),
      vol: numberOr(opts.vol, 1),
      pitch: numberOr(opts.pitch, 0),
      voice_id: opts.voice_id,
    }
    if (opts.emotion && opts.emotion !== "auto") voiceSetting.emotion = opts.emotion

    const url = `${joinURL(opts.base_url, "")}${opts.group_id ? `?GroupId=${encodeURIComponent(opts.group_id)}` : ""}`
    const data = await fetchJSON(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.api_key}`,
        "Content-Type": "application/json",
      },
      body: {
        model: opts.model,
        text,
        stream: false,
        language_boost: opts.language_boost,
        voice_setting: voiceSetting,
        audio_setting: {
          sample_rate: numberOr(opts.sample_rate, 32000),
          bitrate: numberOr(opts.bitrate, 128000),
          format: opts.format || "wav",
        },
      },
      timeoutMs: opts.timeout_ms,
    })

    const code = data?.base_resp?.status_code
    if (code != null && code !== 0) throw new Error(`MiniMax TTS 失败 [${code}]: ${data.base_resp?.status_msg || "未知错误"}`)
    const hex = data?.data?.audio
    if (!hex) throw new Error("MiniMax TTS 响应缺少音频数据")
    return saveAudio(Buffer.from(String(hex).replace(/\s+/g, ""), "hex"), extFromFormat(opts.format, "wav"))
  },
}
