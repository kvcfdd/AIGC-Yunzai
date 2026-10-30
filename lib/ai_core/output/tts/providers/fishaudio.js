import { encode } from "../msgpack.js"
import { extFromFormat, fetchBytes, fetchJSON, saveAudio } from "../util.js"

const REFERENCE_ID_RE = /^[a-fA-F0-9]{32}$/

function authHeaders(opts) {
  return { Authorization: `Bearer ${opts.api_key}`, model: opts.model }
}

/** 优先使用配置的 reference_id；否则按角色名查询模型 ID */
async function resolveReferenceId(opts) {
  const configured = String(opts.reference_id || "").trim()
  if (configured) {
    if (!REFERENCE_ID_RE.test(configured)) throw new Error("FishAudio reference_id 必须是 32 位十六进制字符串")
    return configured
  }

  const character = String(opts.character || "").trim()
  if (!character) return null
  const root = String(opts.base_url || "")
    .replace(/\/v1\/?$/, "")
    .replace(/\/+$/, "")

  for (const sortBy of ["score", "task_count", "created_at"]) {
    const qs = new URLSearchParams({ title: character, sort_by: sortBy })
    const data = await fetchJSON(`${root}/model?${qs}`, { headers: authHeaders(opts), timeoutMs: opts.timeout_ms })
    if (!data?.total) continue
    const hit = (data.items || []).find(item => String(item?.title || "").includes(character))
    if (hit?._id) return hit._id
  }
  return null
}

/** FishAudio —— 请求体为 MessagePack，响应为音频字节 */
export default {
  label: "FishAudio TTS",
  defaults: {
    base_url: "https://api.fish.audio/v1",
    model: "s2-pro",
    reference_id: "",
    character: "可莉",
    format: "wav",
    timeout_ms: 20_000,
  },
  ready: opts => !!opts.api_key,
  async tts(text, opts) {
    const referenceId = await resolveReferenceId(opts)
    const body = {
      text,
      chunk_length: 200,
      format: opts.format || "wav",
      mp3_bitrate: 128,
      references: [],
      reference_id: referenceId,
      normalize: true,
      latency: "normal",
    }
    const base = String(opts.base_url || "").replace(/\/+$/, "")
    const buf = await fetchBytes(`${base}/tts`, {
      method: "POST",
      headers: {
        ...authHeaders(opts),
        "Content-Type": "application/msgpack",
        Accept: "audio/*",
      },
      body: encode(body),
      timeoutMs: opts.timeout_ms,
    })
    return saveAudio(buf, extFromFormat(opts.format, "wav"))
  },
}
