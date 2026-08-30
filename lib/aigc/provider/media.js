import { exec, spawn } from "node:child_process"
import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import log from "../helpers/log.js"

const MAX_IMAGE_PX = 1536
const IMAGE_FAST_THRESHOLD = 1.5 * 1024 * 1024 // 低于此值压缩无意义, 100 质量统一格式
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024 // 压缩前下载上限 20MB/张
const MAX_VIDEO_BYTES = 20 * 1024 * 1024 // 压缩后输出上限 20MB
export const MAX_VIDEO_DOWNLOAD = 80 * 1024 * 1024 // 下载上限 80MB
const MAX_VIDEO_PX = 720 // GIF 转 MP4 缩放高度上限
const MAX_VIDEO_FRAMES = 60 // 视频/GIF 统一 1s/帧抽帧，60帧封顶
export const MAX_AUDIO_DOWNLOAD = 25 * 1024 * 1024 // 下载上限 25MB/条（QQ 语音 ≤60s 的 silk 通常 <1MB）
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024 // FLAC 输出上限 20MB
export const MAX_FILE_DOWNLOAD = 20 * 1024 * 1024 // 文件下载上限 20MB/个
const SILK_SAMPLE_RATE = 24000 // QQ 语音 silk 采样率

// 文档类文件: 扩展名 → MIME
const EXT_MIME = {
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  csv: "text/csv",
  json: "application/json",
  xml: "text/xml",
  rtf: "text/rtf",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  py: "text/x-python",
  yaml: "text/plain",
  yml: "text/plain",
  scss: "text/plain",
  less: "text/plain",
  vue: "text/plain",
  svelte: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  java: "text/plain",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  hpp: "text/plain",
  cc: "text/plain",
  cs: "text/plain",
  swift: "text/plain",
  kt: "text/plain",
  kts: "text/plain",
  php: "text/plain",
  rb: "text/plain",
  lua: "text/plain",
  r: "text/plain",
  scala: "text/plain",
  dart: "text/plain",
  sh: "text/plain",
  bash: "text/plain",
  zsh: "text/plain",
  sql: "text/plain",
  ini: "text/plain",
  toml: "text/plain",
  conf: "text/plain",
}
// 识别出但不在列内的格式: 可读文本降级为 text/plain，二进制视为无法识别
const GEMINI_DOCUMENT_MIMES = new Set(["application/pdf", "text/plain", "text/markdown", "text/html", "text/css", "text/javascript", "text/x-typescript", "text/x-python", "text/xml", "text/csv", "text/rtf", "application/json"])

// MIME → 扩展名反查
const MIME_EXT = {}
for (const [ext, mime] of Object.entries(EXT_MIME)) {
  if (!(mime in MIME_EXT)) MIME_EXT[mime] = ext
}
const mimeToExt = mime => MIME_EXT[mime] || ""

// 媒体缓存目录: 下载的图片/视频/语音/文件原文件落盘于此，长久保存供历史引用
const MEDIA_CACHE_DIR = path.resolve("data/aigc/chat")

const KIND_LABEL = { image: "图片", video: "视频", audio: "音频", file: "文件" }

// 文件名后缀 → 媒体类别
const FILE_IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|heic|heif|tiff?|svg|ico)$/i
const FILE_VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|flv|wmv|m4v|3gp|ts|mpeg|mpg)$/i
const FILE_AUDIO_EXT = /\.(mp3|wav|flac|m4a|ogg|aac|opus|amr|silk|wma)$/i

/** 按文件名后缀识别媒体类别: image/video/audio，识别不出返回 null */
function classifyFileExt(name) {
  if (FILE_IMG_EXT.test(name || "")) return "image"
  if (FILE_VIDEO_EXT.test(name || "")) return "video"
  if (FILE_AUDIO_EXT.test(name || "")) return "audio"
  return null
}
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

/** 腾讯 silk v3 头判断 */
function isSilk(buf) {
  return (buf.length >= 10 && buf[0] === 0x02 && buf.subarray(1, 10).toString("latin1") === "#!SILK_V3") || (buf.length >= 9 && buf.subarray(0, 9).toString("latin1") === "#!SILK_V3")
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
  if (kind === "audio") return isSilk(buf) ? "silk" : "audio"
  return kind
}

/** 写入媒体缓存目录，返回标准化绝对路径；name 可选，拼入文件名 */
async function saveToCache(buf, kind, ext, name) {
  await mkdir(MEDIA_CACHE_DIR, { recursive: true })
  const label = name ? `_${name}` : ""
  const file = path.join(MEDIA_CACHE_DIR, `aigc_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${label}.${ext}`)
  await writeFile(file, buf)
  return normPath(file)
}

/** 文件落盘的名称部分: 去扩展名、去路径分隔符/非法字符、截断 */
function safeFileBase(name) {
  const n = (name || "").replace(/\\/g, "/")
  const base = path.basename(n, path.extname(n))
  return base
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
}

/** 解析媒体来源 → 缓存本地文件。
 *  http(s) URL 下载后落盘缓存不删除；本地路径复制入缓存。
 *  已在缓存目录内的路径直接复用，不重复复制。
 *  @param {string} source - http(s) URL / data 之外的文件路径
 *  @param {{ kind: "image"|"video"|"audio"|"file", headers?, dispatcher?, maxBytes, signal?, name? }} [opts]
 *  @returns {Promise<{ file: string, mime?: string }>} */
async function mediaToFile(source, { kind = "image", headers = {}, dispatcher, maxBytes, signal, name } = {}) {
  const isFile = kind === "file"
  // data URI 解码 → 大小校验 → 落盘缓存
  if (typeof source === "string" && source.startsWith("data:")) {
    const semi = source.indexOf(";")
    if (semi < 0 || source.indexOf(",") < 0) throw new Error("data URI 格式错误")
    const mime = source.slice(5, semi)
    const buf = Buffer.from(source.slice(source.indexOf(",") + 1), "base64")
    if (buf.length > maxBytes) throw oversize(kind, buf.length)
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    if (!isFile) return { file: await saveToCache(buf, kind, sniffExt(buf, kind)) }
    const docMime = GEMINI_DOCUMENT_MIMES.has(mime) ? mime : looksLikeText(buf) ? "text/plain" : null
    if (!docMime && !sniffMediaKind(buf, null)) {
      log.debug(`文件格式无法识别，不缓存: ${name || "(data URI)"}`)
      return { file: null, mime: null }
    }
    return { file: await saveToCache(buf, kind, fileSaveExt(mimeToExt(mime), docMime), safeFileBase(name)), mime: docMime }
  }
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

    // 文件: 魔数自行判断 → 文件名后缀 → 可读文本兜底，无法识别 mime 为 null
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
      const cd = res.headers.get("content-disposition") || ""
      const m = cd.match(/filename\*\s*=\s*utf-8''([^;]+)/i) || cd.match(/filename\s*=\s*"([^"]+)"/i) || cd.match(/filename\s*=\s*([^;]+)/i)
      if (m) {
        try {
          ext = path.extname(decodeURIComponent(m[1].trim())).slice(1).toLowerCase()
        } catch {
          /* 畸形百分号编码 → 放弃该来源的扩展名 */
        }
      }
    }
    const mime = resolveDocMime(buf, ext)
    // 无法识别且非媒体 → 不落盘，避免无用的二进制垃圾永久占用缓存
    if (!mime && !sniffMediaKind(buf, null)) {
      log.debug(`文件格式无法识别，不缓存: ${name || source}`)
      return { file: null, mime: null }
    }
    // 名称: 优先 URL 路径末段，其次调用方传入的 name
    let rawName = ""
    try {
      const p = new URL(source).pathname
      if (p) rawName = decodeURIComponent(p.split("/").pop() || "")
    } catch {}
    return { file: await saveToCache(buf, kind, fileSaveExt(ext, mime), safeFileBase(rawName || name)), mime }
  }

  // 本地路径: 绝对路径或基于项目目录的相对路径
  const abs = normPath(path.isAbsolute(normPath(source)) ? source : path.resolve(source))
  if (isUnderCache(abs)) {
    if (!isFile) return { file: abs }
    // 缓存命中: 读内容自行判断，与首次下载同一解析逻辑
    const buf = await readFile(abs)
    const ext = path.extname(abs).slice(1).toLowerCase() || (name ? path.extname(name).slice(1).toLowerCase() : "")
    return { file: abs, mime: resolveDocMime(buf, ext) }
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
  const mime = resolveDocMime(buf, ext)
  // 无法识别且非媒体 → 不落盘，避免无用的二进制垃圾永久占用缓存
  if (!mime && !sniffMediaKind(buf, null)) {
    log.debug(`文件格式无法识别，不缓存: ${name || abs}`)
    return { file: null, mime: null }
  }
  return { file: await saveToCache(buf, kind, fileSaveExt(ext, mime), safeFileBase(name || path.basename(abs))), mime }
}

/** 缓存图片文件或 Buffer → sharp 压缩 → data URI
 *  @param {string|Buffer} file - 文件路径或图片 Buffer */
async function imageFileToDataUri(file) {
  const encode = (fmt, buf) => `data:image/${fmt};base64,${buf.toString("base64")}`
  const inputSize = typeof file === "string" ? (await stat(file)).size : file.length
  const quality = inputSize < IMAGE_FAST_THRESHOLD ? 100 : 90

  const compress = async fmt => {
    const image = sharp(file).resize(MAX_IMAGE_PX, MAX_IMAGE_PX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    if (fmt === "webp") return image.webp({ quality }).toBuffer()
    if (fmt === "jpeg") return image.jpeg({ quality }).toBuffer()
  }

  try {
    return encode("webp", await compress("webp"))
  } catch (err) {
    log.debug(`WebP 压缩失败，尝试 JPEG: ${err.message}`)
  }

  try {
    return encode("jpeg", await compress("jpeg"))
  } catch (err) {
    log.debug(`JPEG 压缩失败: ${err.message}`)
  }

  throw new Error("图片格式无法解码")
}

/** 缓存图片文件 → data URI；动画 GIF 特化转视频编码，其余 sharp 压缩 */
async function encodeImageFile(file, signal) {
  if (typeof file === "string" && file.toLowerCase().endsWith(".gif") && (await isAnimatedGif(file)) === true) {
    return videoFileToDataUri(file, false, signal, { gif: true })
  }
  return imageFileToDataUri(file)
}

/** 判断 GIF 是否含多帧动画
 *  @returns {Promise<boolean|null>} */
async function isAnimatedGif(file) {
  try {
    const n = await new Promise((resolve, reject) => {
      const p = exec(`ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames,nb_frames -of csv=p=0 "${file}"`, { timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())))
      p.stderr?.on("data", () => {})
    })
    const [read, total] = n.split(",").map(x => Number(x))
    const frames = Number.isFinite(read) && read > 0 ? read : Number.isFinite(total) && total > 0 ? total : 0
    return frames > 1
  } catch {
    return null
  }
}

/** 缓存视频文件 → ffprobe/ffmpeg 压缩 → data URI
 *  @param {boolean} removeAudio - 是否移除音轨
 *  @param {AbortSignal} [signal] - 中断信号
 *  @param {object} [opts] - { gif: boolean } 动画 GIF 特化: 透明背景合成白底 */
async function videoFileToDataUri(file, removeAudio = false, signal, opts = {}) {
  const { gif = false } = opts
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
    let probeFps = 1 // 1 秒 1 帧
    try {
      const dur = await new Promise((resolve, reject) => {
        const p = exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`, { timeout: 10000 }, (err, stdout) => {
          if (err) return reject(err)
          resolve(parseFloat(stdout.toString().trim()) || 0)
        })
        p.stderr?.on("data", () => {})
      })
      if (dur > 0) {
        probeFps = Number(Math.min(1, MAX_VIDEO_FRAMES / dur).toFixed(2))
        log.debug(`${gif ? "GIF 动画" : "视频时长"} ${dur.toFixed(1)}s → ${probeFps}fps（${Math.min(Math.ceil(dur), MAX_VIDEO_FRAMES)} 帧）`)
      }
    } catch {
      // ffprobe 不可用，用默认 fps=1
    }

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    let vf
    if (gif) {
      vf = `fps=${probeFps},scale='trunc(min(1280,iw)/2)*2':'trunc(min(${MAX_VIDEO_PX},ih)/2)*2',format=rgba,split[a][b];[a]format=rgb24,drawbox=c=white:t=fill,format=rgba[bg];[bg][b]overlay=shortest=1:format=rgb`
    } else {
      vf = `fps=${probeFps},scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease`
    }

    // 抽帧 + 压缩
    await new Promise((resolve, reject) => {
      const ff = exec(`ffmpeg -i "${file}" -vf "${vf}" -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -r ${probeFps} -movflags +faststart${audioFlag} -y "${outFile}"`, { timeout: 30000 }, err => (err ? reject(err) : resolve()))
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

/** PCM s16le → ffmpeg 管道编码 FLAC
 *  @param {Uint8Array} pcm - silk-wasm 解码出的 pcm_s16le 数据
 *  @param {AbortSignal} [signal] - 中断信号 */
function pcmToFlac(pcm, signal) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-f", "s16le", "-ar", String(SILK_SAMPLE_RATE), "-ac", "1", "-i", "pipe:0", "-c:a", "flac", "-f", "flac", "pipe:1"])
    const chunks = []
    let onAbort
    ff.stdout.on("data", c => chunks.push(c))
    ff.stderr.on("data", () => {})
    ff.on("error", reject)
    ff.on("close", code => {
      if (signal) signal.removeEventListener("abort", onAbort)
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`FLAC 编码失败 (ffmpeg 退出码 ${code})`))
    })
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
    ff.stdin.on("error", () => {})
    ff.stdin.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    ff.stdin.end()
  })
}

/** 缓存语音文件 → silk-wasm 解码或 ffmpeg 转码 → FLAC data URI
 *  @param {AbortSignal} [signal] - 中断信号 */
async function audioFileToDataUri(file, signal) {
  const buf = await readFile(file)

  // 腾讯 silk v3: 0x02 + "#!SILK_V3" + 帧数据。
  // silk-wasm 的 C 解码器校验完整 10 字节头后自行跳过，不能剥除。
  const silk = isSilk(buf)
  const isTencentSilk = silk && buf[0] === 0x02

  if (silk) {
    // silk-wasm 解码为 24kHz 单声道 pcm_s16le
    const { decode } = await import("silk-wasm")
    const input = isTencentSilk ? buf : Buffer.concat([Buffer.from([0x02]), buf])
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    const { data } = await decode(input, SILK_SAMPLE_RATE)
    if (!data?.length) throw new Error("silk 解码结果为空")
    const flac = await pcmToFlac(data, signal)
    if (flac.length > MAX_AUDIO_BYTES) throw new Error(`音频过长 [${(flac.length / 1024 / 1024).toFixed(1)}MB]`)
    log.debug(`silk 语音解码: ${buf.length} B → ${flac.length} B FLAC`)
    return `data:audio/flac;base64,${flac.toString("base64")}`
  }

  // 非 silk → ffmpeg 转 FLAC
  const tmpDir = path.resolve("data/aigc/tmp")
  await mkdir(tmpDir, { recursive: true })
  const outFile = path.join(tmpDir, `aigc_audio_out_${Date.now()}_${Math.random().toString(36).slice(2)}.flac`)
  let onAbort
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    await new Promise((resolve, reject) => {
      const ff = exec(`ffmpeg -i "${file}" -vn -acodec flac -ar ${SILK_SAMPLE_RATE} -ac 1 -y "${outFile}"`, { timeout: 30000 }, err => (err ? reject(err) : resolve()))
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
    const flac = await readFile(outFile)
    if (!flac.length) throw new Error("ffmpeg 转码结果为空")
    if (flac.length > MAX_AUDIO_BYTES) throw new Error(`音频过长 [${(flac.length / 1024 / 1024).toFixed(1)}MB]`)
    return `data:audio/flac;base64,${flac.toString("base64")}`
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
    await unlink(outFile).catch(() => {})
  }
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
  if (isSilk(buf)) return "audio"
  if (buf.length > 4 && buf.subarray(0, 4).toString("latin1") === "#!AMR") return "audio"
  if (buf.length > 2 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return "audio" // ID3 mp3
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio" // mp3 帧同步
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "OggS") return "audio"
  if (buf.length > 3 && buf.subarray(0, 4).toString("latin1") === "fLaC") return "audio"
  if (mime && GEMINI_DOCUMENT_MIMES.has(mime)) return "file"
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

/** 解析文档类文件 MIME: 魔数自行判断 → 文件名后缀 → 可读文本兜底 → 无法识别返回 null。
 *  Gemini 不支持的格式: 可读文本降级为 text/plain，二进制返回 null */
function resolveDocMime(buf, ext) {
  const mime = sniffDocMime(buf) || EXT_MIME[ext] || (looksLikeText(buf) ? "text/plain" : null)
  if (!mime || GEMINI_DOCUMENT_MIMES.has(mime)) return mime
  if (looksLikeText(buf)) return "text/plain"
  log.debug(`文档格式 ${mime} 格式不支持`)
  return null
}

/** 文件落盘后缀: 降级为纯文本给 txt，否则保留原后缀 */
function fileSaveExt(ext, mime) {
  return mime === "text/plain" && EXT_MIME[ext] !== "text/plain" ? "txt" : ext || "bin"
}

/** 缓存文件 → data URI */
async function fileToDataUri(file, mime) {
  const buf = await readFile(file)
  return `data:${mime || "application/octet-stream"};base64,${buf.toString("base64")}`
}

export { GEMINI_DOCUMENT_MIMES, mediaToFile, sniffMediaKind, imageFileToDataUri, videoFileToDataUri, audioFileToDataUri, fileToDataUri, isAnimatedGif, classifyFileExt, encodeImageFile }
