import cfg from "../../config/config.js"
import log from "../helpers/log.js"

const API_BASE = "https://v1.wusound.cn"

/** 校验语音配置是否完整 */
function checkConfig() {
  const vcfg = cfg.aigc?.voice || {}
  if (!vcfg.api_key) return { ok: false, reason: "未配置 voice.api_key，语音功能无法使用！" }
  if (!vcfg.voice_id) return { ok: false, reason: "未配置 voice.voice_id，语音功能无法使用！" }
  return { ok: true }
}

/** 查询账户剩余点数，不足 100 则返回错误 */
async function checkcredit() {
  const vcfg = cfg.aigc?.voice || {}
  const res = await fetch(`${API_BASE}/api/account/info`, {
    headers: { Authorization: `Bearer ${vcfg.api_key}` },
  })

  if (!res.ok) {
    log.error(`语音点数查询失败 [${res.status}]`)
    return {
      ok: false,
      reason: `点数查询失败 (HTTP ${res.status})，请稍后重试`,
    }
  }

  const data = await res.json()
  const credit = data?.user?.credit
  if (credit === undefined || credit === null) {
    return { ok: false, reason: "无法获取账户点数信息" }
  }
  if (credit < 100) {
    return { ok: false, reason: `剩余点数不足` }
  }
  return { ok: true, credit }
}

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

export default { tts, checkConfig, checkcredit }
