import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { getDownloadProxyDispatcher } from "../../llm/network-proxy.js"

/** 合成音频落盘目录 */
const TTS_DIR = path.resolve(process.cwd(), "data/aigc/tts")

export const DEFAULT_TIMEOUT_MS = 20_000

/** 拼接 URL 路径，去掉 base 末尾多余斜杠 */
export function joinURL(base, suffix) {
  return `${String(base || "").replace(/\/+$/, "")}${suffix}`
}

/** 超时信号 —— 非正数回落到默认值 */
export function timeoutSignal(ms, fallback = DEFAULT_TIMEOUT_MS) {
  const n = Number(ms)
  return AbortSignal.timeout(Number.isFinite(n) && n > 0 ? n : fallback)
}

/** 统一请求：返回 Buffer；非 2xx 抛出带状态码和响应片段的错误 */
export async function fetchBytes(url, { method = "GET", headers = {}, body, timeoutMs } = {}) {
  const dispatcher = getDownloadProxyDispatcher()
  const res = await fetch(url, {
    method,
    headers,
    ...(body == null ? {} : { body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
    signal: timeoutSignal(timeoutMs),
    ...(dispatcher ? { dispatcher } : {}),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`${method} ${url} 失败 [${res.status}]${detail ? `: ${String(detail).slice(0, 500)}` : ""}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/** 请求 JSON */
export async function fetchJSON(url, options = {}) {
  const buf = await fetchBytes(url, options)
  const text = buf.toString("utf8")
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${url} 返回了非 JSON 响应: ${text.slice(0, 200)}`)
  }
}

/** 音频字节写入临时文件，返回绝对路径 */
export async function saveAudio(data, ext = "mp3") {
  await fs.mkdir(TTS_DIR, { recursive: true })
  const safeExt =
    String(ext || "mp3")
      .replace(/^\./, "")
      .replace(/[^\w]/g, "") || "mp3"
  const file = path.join(TTS_DIR, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${safeExt}`)
  await fs.writeFile(file, data)
  return file
}

/** PCM（默认 24kHz / 单声道 / 16bit）加 WAV 头 */
export function wavFromPcm(pcm, { sampleRate = 24000, channels = 1, bitDepth = 16 } = {}) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm)
  const byteRate = (sampleRate * channels * bitDepth) / 8
  const blockAlign = (channels * bitDepth) / 8
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitDepth, 34)
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** 配置里的音频格式 → 文件扩展名 */
export function extFromFormat(format, fallback = "mp3") {
  const fmt = String(format || "").toLowerCase()
  if (fmt.includes("wav") || fmt.includes("riff")) return "wav"
  if (fmt.includes("mp3")) return "mp3"
  if (fmt.includes("opus")) return "opus"
  if (fmt.includes("ogg")) return "ogg"
  if (fmt.includes("aac")) return "aac"
  if (fmt.includes("flac")) return "flac"
  if (fmt.includes("pcm")) return "pcm"
  return fallback
}

/** 数字配置归一化 */
export function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 布尔配置归一化 */
export function boolOr(value, fallback) {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const s = value.trim().toLowerCase()
    if (["true", "1", "yes", "on"].includes(s)) return true
    if (["false", "0", "no", "off"].includes(s)) return false
  }
  return fallback
}

/** XML 文本转义 */
export function xmlEscape(text) {
  return String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c])
}

/** 空字符串视为未配置 */
export function optional(value) {
  return value === "" || value == null ? undefined : value
}
