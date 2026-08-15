import cfg from "../../config/config.js"
import log from "../helpers/log.js"

const API_BASE = "https://v1.wusound.cn"

/** 调用悟声 TTS API 生成语音，返回音频直链 */
async function tts(text) {
  const vcfg = cfg.aigc?.voice || {}
  const apiKey = vcfg.api_key
  if (!apiKey) throw new Error("未配置 voice.api_key")
  if (!vcfg.voice_id) throw new Error("未配置 voice.voice_id")

  const body = {
    voiceId: vcfg.voice_id,
    text,
    break_clone: vcfg.break_clone ?? true,
    vivid: true,
    preset: vcfg.preset || "balance",
    speechRate: vcfg.speech_rate ?? 1,
    emo_switch: [0, 0, 0, 0, 0],
  }

  const res = await fetch(`${API_BASE}/api/tts/simple-generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let detail = ""
    try {
      detail = await res.text()
    } catch {
      /* pass */
    }
    const msg = {
      400: "请求参数错误",
      403: "剩余点数不足",
      404: "未找到指定的模型或语音",
      500: "服务器内部错误",
    }[res.status]
    throw new Error(`TTS API 错误 [${res.status}]${msg ? `: ${msg}` : ""}${detail ? ` — ${detail}` : ""}`)
  }

  const data = await res.json()
  const audioUrl = data?.data?.audio
  if (!audioUrl) throw new Error("TTS 响应缺少音频 URL")

  log.debug(`TTS 生成成功，消耗 ${data.data.credit_used} 点数`)

  return audioUrl
}

export default { tts }
