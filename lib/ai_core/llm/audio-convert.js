import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises"
import path from "node:path"
import log from "../helpers/log.js"

const TMP_DIR = path.resolve("data/aigc/tmp")
const FLAC_RE = /^data:audio\/(?:flac|x-flac);base64,(.+)$/i

/** OpenAI 只接受 wav/mp3；媒体层统一产出 FLAC，这里按需转 MP3 */
export async function flacDataUriToMp3(uri, signal) {
  const m = FLAC_RE.exec(uri)
  if (!m) return uri
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

  await mkdir(TMP_DIR, { recursive: true })
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const inFile = path.join(TMP_DIR, `aigc_${id}.flac`)
  const outFile = path.join(TMP_DIR, `aigc_${id}.mp3`)
  await writeFile(inFile, Buffer.from(m[1], "base64"))

  let child
  let onAbort
  try {
    await new Promise((resolve, reject) => {
      child = execFile("ffmpeg", ["-y", "-i", inFile, "-vn", "-ar", "24000", "-ac", "1", "-b:a", "64k", outFile], { timeout: 30_000 }, err => (err ? reject(err) : resolve()))
      onAbort = () => {
        child?.kill()
        reject(new DOMException("Aborted", "AbortError"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    const buf = await readFile(outFile)
    if (!buf.length) throw new Error("mp3 转码结果为空")
    return `data:audio/mpeg;base64,${buf.toString("base64")}`
  } catch (err) {
    if (err?.name === "AbortError") throw err
    log.warn(`FLAC→MP3 转码失败: ${err.message}`)
    return uri
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort)
    await unlink(inFile).catch(() => {})
    await unlink(outFile).catch(() => {})
  }
}
