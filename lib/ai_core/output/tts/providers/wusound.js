import { joinURL, timeoutSignal } from "../util.js"

/** 悟声 Wusound */
export default {
  label: "悟声 Wusound",
  defaults: {
    base_url: "https://v1.wusound.cn",
    break_clone: true,
    preset: "balance",
    speech_rate: 1,
    timeout_ms: 120_000,
  },
  ready: opts => !!opts.api_key && !!opts.voice_id,
  async tts(text, opts) {
    const res = await fetch(joinURL(opts.base_url, "/api/tts/simple-generate"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.api_key}`,
      },
      body: JSON.stringify({
        voiceId: opts.voice_id,
        text,
        break_clone: opts.break_clone ?? true,
        vivid: true,
        preset: opts.preset || "balance",
        speechRate: opts.speech_rate ?? 1,
        emo_switch: [0, 0, 0, 0, 0],
      }),
      signal: timeoutSignal(opts.timeout_ms, 120_000),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      const hint = {
        400: "请求参数错误",
        403: "剩余点数不足",
        404: "未找到指定的模型或语音",
        500: "服务器内部错误",
      }[res.status]
      throw new Error(`悟声 TTS 错误 [${res.status}]${hint ? `: ${hint}` : ""}${detail ? ` — ${String(detail).slice(0, 500)}` : ""}`)
    }

    const data = await res.json()
    const audio = data?.data?.audio
    if (!audio) throw new Error("悟声 TTS 响应缺少音频 URL")
    return audio
  },
}
