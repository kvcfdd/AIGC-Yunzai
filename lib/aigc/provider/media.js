import { exec } from "node:child_process"
import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import log from "../helpers/log.js"

const MAX_IMAGE_PX = 1568
const WEBP_QUALITY = 80
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024 // 压缩前下载上限 20MB/张
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024 // 压缩后输出上限 50MB（base64 约 67MB，低于 100MB 请求体上限）
export const MAX_VIDEO_DOWNLOAD = 80 * 1024 * 1024 // 下载上限 80MB
const MAX_VIDEO_PX = 720 // 抽帧后目标高度
const VIDEO_CRF = 20 // 画质优先
export const MAX_AUDIO_DOWNLOAD = 25 * 1024 * 1024 // 下载上限 25MB/条（QQ 语音 ≤60s 的 silk 通常 <1MB）
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024 // 解码后 WAV 上限 50MB（base64 约 67MB；24kHz 单声道约 18 分钟）
export const MAX_FILE_DOWNLOAD = 20 * 1024 * 1024 // 文件下载上限 20MB/个
const SILK_SAMPLE_RATE = 24000 // QQ 语音 silk 采样率

// 文档类文件: 扩展名 → MIME（Gemini document 部件支持的类型）
const EXT_MIME = {
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  csv: "text/csv",
  json: "application/json",
  xml: "text/xml",
  yaml: "text/x-yaml",
  yml: "text/x-yaml",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/x-typescript",
  py: "text/x-python",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  java: "text/x-java",
  go: "text/x-go",
  rs: "text/x-rust",
  sh: "text/x-shellscript",
  sql: "text/x-sql",
  ini: "text/plain",
  toml: "text/plain",
  conf: "text/plain",
}
// 允许作为 Gemini document 部件内联的类型
const DOCUMENT_MIMES = new Set(Object.values(EXT_MIME))

// 媒体缓存目录: 下载的图片/视频/语音/文件原文件落盘于此，长久保存供历史引用
const MEDIA_CACHE_DIR = path.resolve("data/aigc/chat")

const KIND_LABEL = { image: "图片", video: "视频", audio: "音频", file: "文件" }
const oversize = (kind, size) => new Error(`${KIND_LABEL[kind]}过大 [${(size / 1024 / 1024).toFixed(1)}MB]`)

/** 统一路径分隔符为 "/"，便于 LLM 在文本中引用本地路径 */
function normPath(p) {
  return p.replace(/\\/g, "/")
}

/** 判断路径是否已在媒体缓存目录内 */
function isUnderCache(absPath) {
  const a = normPath(absPath)
  const root = normPath(MEDIA_CACHE_DIR)
  return a === root || a.startsWith(root + "/")
}

/** 根据魔数嗅探缓存文件扩展名 */
function sniffExt(buf, kind) {
  if (kind === "image") {
    if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg"
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png"
    if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp"
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif"
    return "img"
  }
  if (kind === "video") return "mp4"
  if (kind === "audio") {
    const isSilk = (buf.length > 10 && buf[0] === 0x02 && buf.subarray(1, 10).toString("latin1") === "#!SILK_V3") || (buf.length > 9 && buf.subarray(0, 9).toString("latin1") === "#!SILK_V3")
    return isSilk ? "silk" : "audio"
  }
  return kind
}

/** 写入媒体缓存目录，返回标准化绝对路径 */
async function saveToCache(buf, kind, ext) {
  await mkdir(MEDIA_CACHE_DIR, { recursive: true })
  const file = path.join(MEDIA_CACHE_DIR, `aigc_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`)
  await writeFile(file, buf)
  return normPath(file)
}

/** 解析媒体来源 → 缓存本地文件。
 *  http(s) URL 下载后落盘缓存不删除；本地路径复制入缓存。
 *  已在缓存目录内的路径直接复用，不重复复制。
 *  @param {string} source - http(s) URL / data 之外的文件路径
 *  @param {{ kind: "image"|"video"|"audio"|"file", headers?, dispatcher?, maxBytes, signal?, name? }} [opts]
 *  @returns {Promise<{ file: string, mime?: string }>} */
async function mediaToFile(source, { kind = "image", headers = {}, dispatcher, maxBytes, signal, name } = {}) {
  const isFile = kind === "file"
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, {
      headers,
      ...(dispatcher ? { dispatcher } : {}),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) throw new Error(`下载失败 [${res.status}]`)
    const cl = res.headers.get("content-length")
    if (cl) {
      const size = parseInt(cl, 10)
      if (size > maxBytes) throw oversize(kind, size)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw oversize(kind, buf.length)
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    if (!isFile) return { file: await saveToCache(buf, kind, sniffExt(buf, kind)) }

    // 文件: 保留原始扩展名与 MIME
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
    const cd = res.headers.get("content-disposition") || ""
    let ext = ""
    try {
      ext = path.extname(new URL(source).pathname).slice(1).toLowerCase()
    } catch {}
    if (!ext)
      ext = path
        .extname(name || "")
        .slice(1)
        .toLowerCase()
    if (!ext) {
      // Content-Disposition: filename* (RFC 5987) 优先，其次 filename（带引号/裸名）
      const m = cd.match(/filename\*\s*=\s*utf-8''([^;]+)/i) || cd.match(/filename\s*=\s*"([^"]+)"/i) || cd.match(/filename\s*=\s*([^;]+)/i)
      if (m) ext = path.extname(decodeURIComponent(m[1].trim())).slice(1).toLowerCase()
    }
    // octet-stream 等同未知，回退扩展名映射
    const mime = (ct && ct !== "application/octet-stream" ? ct : null) || EXT_MIME[ext] || null
    return { file: await saveToCache(buf, kind, ext || "bin"), mime }
  }

  // 本地路径: 绝对路径或基于项目目录的相对路径
  const abs = normPath(path.isAbsolute(normPath(source)) ? source : path.resolve(source))
  if (isUnderCache(abs)) {
    if (!isFile) return { file: abs }
    const byPath = EXT_MIME[path.extname(abs).slice(1).toLowerCase()]
    const byName = name ? EXT_MIME[path.extname(name).slice(1).toLowerCase()] : undefined
    return { file: abs, mime: byPath || byName || null }
  }
  const buf = await readFile(abs)
  if (buf.length > maxBytes) throw oversize(kind, buf.length)
  if (!isFile) return { file: await saveToCache(buf, kind, sniffExt(buf, kind)) }

  let ext = path.extname(abs).slice(1).toLowerCase()
  if (!ext)
    ext = path
      .extname(name || "")
      .slice(1)
      .toLowerCase()
  const mime = EXT_MIME[ext] || null
  return { file: await saveToCache(buf, kind, ext || "bin"), mime }
}

/** 缓存图片文件 → sharp 压缩 → data URI */
async function imageFileToDataUri(file) {
  const encode = (fmt, buf) => `data:image/${fmt};base64,${buf.toString("base64")}`

  const compress = async fmt => {
    const image = sharp(file).resize(MAX_IMAGE_PX, MAX_IMAGE_PX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    if (fmt === "webp") return image.webp({ quality: WEBP_QUALITY }).toBuffer()
    if (fmt === "jpeg") return image.jpeg({ quality: WEBP_QUALITY }).toBuffer()
  }

  try {
    return encode("webp", await compress("webp"))
  } catch (err) {
    log.debug(`WebP 压缩失败，尝试 JPEG: ${err.message}`)
  }

  try {
    return encode("jpeg", await compress("jpeg"))
  } catch (err) {
    log.debug(`JPEG 压缩失败，使用原图: ${err.message}`)
  }

  // 兜底: 原图直出
  let fmt = "jpeg"
  try {
    fmt = (await sharp(file).metadata()).format || "jpeg"
  } catch {}
  return encode(fmt, await readFile(file))
}

/** 缓存视频文件 → ffprobe/ffmpeg 压缩 → data URI
 *  @param {boolean} removeAudio - 是否移除音轨
 *  @param {AbortSignal} [signal] - 中断信号 */
async function videoFileToDataUri(file, removeAudio = false, signal) {
  const tmpDir = path.resolve("data/aigc/tmp")
  await mkdir(tmpDir, { recursive: true })

  const outFile = path.join(tmpDir, `aigc_video_out_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`)

  let finalBuf
  const audioFlag = removeAudio ? " -an" : ""
  let onAbort
  try {
    const inSize = (await stat(file)).size
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    // ffprobe 探时长 → 动态算 fps，保证全程均匀覆盖
    let probeFps = 2 // 默认值
    try {
      const dur = await new Promise((resolve, reject) => {
        const p = exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`, { timeout: 10000 }, (err, stdout) => {
          if (err) return reject(err)
          resolve(parseFloat(stdout.toString().trim()) || 0)
        })
        p.stderr?.on("data", () => {})
      })
      if (dur > 0) {
        // 目标 15 帧均匀覆盖全程, 帧率钳位 [0.5, 2]
        const raw = 15 / dur
        probeFps = Number(Math.max(0.5, Math.min(2, raw)).toFixed(2))
        log.debug(`视频时长 ${dur.toFixed(1)}s → fps=${probeFps}`)
      }
    } catch {
      // ffprobe 不可用，用默认 fps=2
    }

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    // 抽帧 + 压缩
    await new Promise((resolve, reject) => {
      const ff = exec(`ffmpeg -i "${file}" -vf "fps=${probeFps},scale='min(1280,iw)':'min(${MAX_VIDEO_PX},ih)':force_original_aspect_ratio=decrease" -c:v libx264 -crf ${VIDEO_CRF} -preset medium -pix_fmt yuv420p -movflags +faststart${audioFlag} -y "${outFile}"`, { timeout: 60000 }, err => (err ? reject(err) : resolve()))
      ff.stderr?.on("data", () => {})
      if (signal) {
        onAbort = () => {
          ff.kill()
          reject(new DOMException("Aborted", "AbortError"))
        }
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) {
          ff.kill()
          reject(new DOMException("Aborted", "AbortError"))
        }
      }
    })
    const compressed = await readFile(outFile)
    if (compressed.length > MAX_VIDEO_BYTES || compressed.length <= 0) {
      throw new Error(`压缩后仍超 ${MAX_VIDEO_BYTES / 1024 / 1024}MB [${(compressed.length / 1024 / 1024).toFixed(1)}MB]`)
    }
    finalBuf = compressed
    log.debug(`视频处理: ${(inSize / 1024 / 1024).toFixed(1)}MB → ${(compressed.length / 1024 / 1024).toFixed(1)}MB`)
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
    await unlink(outFile).catch(() => {})
  }

  return `data:video/mp4;base64,${finalBuf.toString("base64")}`
}

/** PCM s16le → 44 字节 WAV 头 + 数据
 *  @param {Uint8Array} pcm - silk-wasm 解码出的 pcm_s16le 数据
 *  @param {number} [sampleRate] - 采样率，默认 24000（QQ 语音） */
function pcmToWavBuffer(pcm, sampleRate = SILK_SAMPLE_RATE) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const buf = Buffer.alloc(44 + data.length)
  buf.write("RIFF", 0, "ascii")
  buf.writeUInt32LE(36 + data.length, 4)
  buf.write("WAVE", 8, "ascii")
  buf.write("fmt ", 12, "ascii")
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // 单声道
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byteRate = 24000 * 1 * 2
  buf.writeUInt16LE(2, 32) // blockAlign
  buf.writeUInt16LE(16, 34) // bitsPerSample
  buf.write("data", 36, "ascii")
  buf.writeUInt32LE(data.length, 40)
  data.copy(buf, 44)
  return buf
}

/** 缓存语音文件 → silk-wasm 解码或 ffmpeg 转码 → WAV data URI
 *  @param {AbortSignal} [signal] - 中断信号 */
async function audioFileToDataUri(file, signal) {
  const buf = await readFile(file)

  // 腾讯 silk v3: 0x02 + "#!SILK_V3" + 帧数据。
  // silk-wasm 的 C 解码器校验完整 10 字节头后自行跳过，不能剥除。
  const isTencentSilk = buf.length > 10 && buf[0] === 0x02 && buf.subarray(1, 10).toString("latin1") === "#!SILK_V3"
  const isRawSilk = buf.length > 9 && buf.subarray(0, 9).toString("latin1") === "#!SILK_V3"

  if (isTencentSilk || isRawSilk) {
    // silk-wasm 解码为 24kHz 单声道 pcm_s16le
    const { decode } = await import("silk-wasm")
    const input = isTencentSilk ? buf : Buffer.concat([Buffer.from([0x02]), buf])
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    const { data } = await decode(input, SILK_SAMPLE_RATE)
    if (!data?.length) throw new Error("silk 解码结果为空")
    const wav = pcmToWavBuffer(data)
    if (wav.length > MAX_AUDIO_BYTES) throw new Error(`音频过长 [${(wav.length / 1024 / 1024).toFixed(1)}MB]`)
    log.debug(`silk 语音解码: ${buf.length} B → ${wav.length} B WAV`)
    return `data:audio/wav;base64,${wav.toString("base64")}`
  }

  // 非 silk → ffmpeg 转 WAV
  const tmpDir = path.resolve("data/aigc/tmp")
  await mkdir(tmpDir, { recursive: true })
  const outFile = path.join(tmpDir, `aigc_audio_out_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`)
  let onAbort
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    await new Promise((resolve, reject) => {
      const ff = exec(`ffmpeg -i "${file}" -vn -acodec pcm_s16le -ar ${SILK_SAMPLE_RATE} -ac 1 -y "${outFile}"`, { timeout: 60000 }, err => (err ? reject(err) : resolve()))
      ff.stderr?.on("data", () => {})
      if (signal) {
        onAbort = () => {
          ff.kill()
          reject(new DOMException("Aborted", "AbortError"))
        }
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) {
          ff.kill()
          reject(new DOMException("Aborted", "AbortError"))
        }
      }
    })
    const wav = await readFile(outFile)
    if (!wav.length) throw new Error("ffmpeg 转码结果为空")
    if (wav.length > MAX_AUDIO_BYTES) throw new Error(`音频过长 [${(wav.length / 1024 / 1024).toFixed(1)}MB]`)
    return `data:audio/wav;base64,${wav.toString("base64")}`
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
    await unlink(outFile).catch(() => {})
  }
}

// 兼容 facade 的 URL 入口封装: 下载/定位到缓存文件后编码，文件落盘不删除
async function imageToDataUri(source, headers = {}, dispatcher) {
  const { file } = await mediaToFile(source, { kind: "image", headers, dispatcher, maxBytes: MAX_IMAGE_BYTES })
  return imageFileToDataUri(file)
}

async function videoToDataUri(source, removeAudio = false, signal) {
  const { file } = await mediaToFile(source, { kind: "video", maxBytes: MAX_VIDEO_DOWNLOAD, signal })
  return videoFileToDataUri(file, removeAudio, signal)
}

async function audioToDataUri(source, signal) {
  const { file } = await mediaToFile(source, { kind: "audio", maxBytes: MAX_AUDIO_DOWNLOAD, signal })
  return audioFileToDataUri(file, signal)
}

/** 按魔数嗅探媒体类型: image/video/audio；文档类按 mime 白名单判定；未知返回 null */
function sniffMediaKind(buf, mime) {
  if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xd8) return "image"
  if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image"
  if (buf.length > 5 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image"
  if (buf.length > 11 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image"
  if (buf.length > 1 && buf[0] === 0x42 && buf[1] === 0x4d) return "image" // bmp
  if (buf.length > 11 && buf.subarray(4, 8).toString("latin1") === "ftyp") {
    return buf.subarray(8, 12).toString("latin1") === "M4A " ? "audio" : "video" // mp4/mov 系
  }
  if (buf.length > 3 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video" // EBML (webm/mkv)
  if (buf.length > 11 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "AVI ") return "video"
  if (buf.length > 11 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WAVE") return "audio"
  if (buf.length > 10 && buf[0] === 0x02 && buf.subarray(1, 10).toString("latin1") === "#!SILK_V3") return "audio"
  if (buf.length > 9 && buf.subarray(0, 9).toString("latin1") === "#!SILK_V3") return "audio"
  if (buf.length > 4 && buf.subarray(0, 4).toString("latin1") === "#!AMR") return "audio"
  if (buf.length > 2 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return "audio" // ID3 mp3
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio" // mp3 帧同步
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "OggS") return "audio"
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "fLaC") return "audio"
  if (mime && DOCUMENT_MIMES.has(mime)) return "file"
  return null
}

/** 按魔数嗅探文档类型 → MIME；未知返回 null。
 *  覆盖 %PDF、OOXML office（PK 头 + [Content_Types].xml，按内部目录区分 word/xl/ppt）。
 *  OLE2 老格式(doc/xls/ppt)无法可靠区分，不嗅探。 */
function sniffDocMime(buf) {
  const latin1 = (start, end) => buf.subarray(start, end).toString("latin1")
  if (buf.length >= 5 && latin1(0, 5) === "%PDF-") return "application/pdf"
  if (buf.length >= 4 && latin1(0, 4) === "PK\x03\x04") {
    const head = latin1(0, Math.min(buf.length, 2048))
    if (!head.includes("[Content_Types].xml")) return null
    if (head.includes("word/")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    if (head.includes("xl/")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if (head.includes("ppt/")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    return null
  }
  return null
}

/** 启发式判断是否为可读文本（无魔数的文本兜底）:
 *  前 4096 字节 UTF-8 严格解码成功 且 可打印字符(含多字节/制表/换行)占比 > 90% */
function looksLikeText(buf) {
  if (!buf.length) return false
  const sample = buf.subarray(0, 4096)
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample)
  } catch {
    return false
  }
  let printable = 0
  for (const b of sample) {
    if (b === 0x09 || b === 0x0a || b === 0x0d || b >= 0x20) printable++
  }
  return printable / sample.length > 0.9
}

/** 缓存文件 → data URI */
async function fileToDataUri(file, mime) {
  const buf = await readFile(file)
  return `data:${mime || "application/octet-stream"};base64,${buf.toString("base64")}`
}

export { MEDIA_CACHE_DIR, EXT_MIME, DOCUMENT_MIMES, mediaToFile, sniffMediaKind, sniffDocMime, looksLikeText, imageFileToDataUri, videoFileToDataUri, audioFileToDataUri, fileToDataUri, imageToDataUri, videoToDataUri, audioToDataUri }
