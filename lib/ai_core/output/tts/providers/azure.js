import { extFromFormat, fetchBytes, saveAudio, xmlEscape } from "../util.js"

/** 订阅密钥 → { token, expire }，Azure token 有效期约 10 分钟 */
const tokenCache = new Map()

async function getToken(opts) {
  const key = `${opts.region}:${opts.subscription_key}`
  const cached = tokenCache.get(key)
  if (cached && cached.expire > Date.now()) return cached.token

  const buf = await fetchBytes(`https://${opts.region}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": opts.subscription_key },
    timeoutMs: opts.timeout_ms,
  })
  const token = buf.toString("utf8").trim()
  if (!token) throw new Error("Azure TTS 获取 token 失败")
  tokenCache.set(key, { token, expire: Date.now() + 9 * 60 * 1000 })
  return token
}

/** 构造 SSML */
export function buildSsml(text, opts) {
  const lang = opts.lang || "zh-CN"
  const voice = xmlEscape(opts.voice)
  const rate = xmlEscape(opts.rate ?? "1")
  const volume = xmlEscape(opts.volume ?? "100")
  const prosody = `<prosody rate='${rate}' volume='${volume}'>${xmlEscape(text)}</prosody>`
  const style = String(opts.style ?? "").trim()
  const role = String(opts.role ?? "").trim()
  const inner = style || role ? `<mstts:express-as${style ? ` style='${xmlEscape(style)}'` : ""}${role ? ` role='${xmlEscape(role)}'` : ""}>${prosody}</mstts:express-as>` : prosody
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='${xmlEscape(lang)}'><voice name='${voice}'>${inner}</voice></speak>`
}

/** Azure 语音服务 —— token + SSML，默认输出 48kHz 单声道 WAV */
export default {
  label: "Azure TTS",
  defaults: {
    region: "eastus",
    voice: "zh-CN-YunxiaNeural",
    style: "cheerful",
    role: "Boy",
    rate: "1",
    volume: "100",
    lang: "zh-CN",
    output_format: "riff-48khz-16bit-mono-pcm",
    timeout_ms: 20_000,
  },
  ready: opts => !!opts.subscription_key,
  async tts(text, opts) {
    const token = await getToken(opts)
    const buf = await fetchBytes(`https://${opts.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": opts.output_format,
      },
      body: buildSsml(text, opts),
      timeoutMs: opts.timeout_ms,
    })
    return saveAudio(buf, extFromFormat(opts.output_format, "wav"))
  },
}
