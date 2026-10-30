import { randomUUID } from "node:crypto"
import { fetchJSON, joinURL, numberOr, saveAudio } from "../util.js"

/** 火山引擎语音合成 —— 返回 base64 mp3 */
export default {
  label: "火山引擎 TTS",
  defaults: {
    base_url: "https://openspeech.bytedance.com/api/v1/tts",
    cluster: "volcano_tts",
    voice_type: "",
    speed_ratio: 1,
    timeout_ms: 20_000,
  },
  ready: opts => !!opts.api_key && !!opts.appid && !!opts.voice_type,
  async tts(text, opts) {
    const data = await fetchJSON(joinURL(opts.base_url, ""), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 火山接口要求 Bearer 后带分号
        Authorization: `Bearer; ${opts.api_key}`,
      },
      body: {
        app: { appid: opts.appid, token: opts.api_key, cluster: opts.cluster },
        user: { uid: randomUUID() },
        audio: {
          voice_type: opts.voice_type,
          encoding: "mp3",
          speed_ratio: numberOr(opts.speed_ratio, 1),
          volume_ratio: 1.0,
          pitch_ratio: 1.0,
        },
        request: {
          reqid: randomUUID(),
          text,
          text_type: "plain",
          operation: "query",
          with_frontend: 1,
          frontend_type: "unitTson",
        },
      },
      timeoutMs: opts.timeout_ms,
    })

    if (!data?.data) throw new Error(`火山引擎 TTS 失败: ${data?.message || "响应缺少音频数据"}`)
    return saveAudio(Buffer.from(data.data, "base64"), "mp3")
  },
}
