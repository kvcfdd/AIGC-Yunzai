import { stat } from "node:fs/promises"
import { mediaToFile, imageFileToDataUris, videoFileToDataUri, audioFileToDataUri, MAX_IMAGE_BYTES, MAX_VIDEO_DOWNLOAD, MAX_AUDIO_DOWNLOAD, MAX_FILE_DOWNLOAD } from "../media/ingest.js"

/** 单项媒体是否已解析成功 —— 占位符([图像异常] 等)与 null 都判否 */
export const mediaResolvedOne = u => typeof u === "string" && u.startsWith("data:")

/** 媒体解析结果是否可直接复用: 全部项编码成功(data URI)，无异常占位符。
 *  打断合并复用 turn 时，被中断请求可能留下占位结果，需重新解析。
 *  图片项可能是数组(超长图切段)，任一段未解析成功即整组重解析；
 *  空数组同样判否 —— 否则会被当作已解析，静默不发任何图片部件，
 *  文件只落盘不编码，file_paths 各项均为路径时即视为已解析 */
export const mediaResolved = res => {
  if (!res) return false
  if (Array.isArray(res.file_paths)) return res.file_paths.every(p => typeof p === "string")
  return Array.isArray(res.uris) && res.uris.every(u => (Array.isArray(u) ? u.length > 0 && u.every(mediaResolvedOne) : mediaResolvedOne(u)))
}

/** 感知层媒体预处理 — 把用户消息里的 URL/路径/data URI 变成当前请求可用的形式。
 *
 *  所有方法返回 { uris, paths } 或 { file_paths }:
 *  - uris 供当前请求内联编码
 *  - paths/file_paths 为缓存文件路径 (data/aigc/chat)；文件不内联，路径随消息单独给出
 *  失败位置 uris 为占位、paths/file_paths 为 null。
 */
export class MediaResolver {
  /** 将图片 URL/路径/data URI 数组预转为 data URI
   *  data URI 与 URL/路径同一管线: 落盘缓存 → 编码，动画 GIF 均匀抽帧
   *  超长图在此切成多段
   *  uris 对应位置为字符串数组
   *  paths 始终每张源图一项，供落盘时以 [xx](路径) 引用 —— 不可随切段展开
   *  否则占位符与路径的对位会错乱 */
  async resolveImages(urls, signal) {
    if (!urls?.length) return null
    const uris = new Array(urls.length)
    const paths = new Array(urls.length).fill(null)
    await Promise.all(
      urls.map(async (u, i) => {
        if (u === "[图像异常]") {
          uris[i] = u
          return
        }
        try {
          const { file } = await mediaToFile(u, { kind: "image", maxBytes: MAX_IMAGE_BYTES, signal })
          uris[i] = await imageFileToDataUris(file, signal)
          paths[i] = file
        } catch (err) {
          logger.debug(`图片处理失败: ${err.message}`)
          uris[i] = "[图像异常]"
        }
      }),
    )
    return { uris, paths }
  }

  /** 下载视频 → 缓存原文件 → ffmpeg 压缩 → data URI */
  async resolveVideo(urls, signal) {
    if (!urls?.length) return null
    const uris = []
    const paths = []
    for (const u of urls) {
      try {
        const { file } = await mediaToFile(u, { kind: "video", maxBytes: MAX_VIDEO_DOWNLOAD, signal })
        uris.push(await videoFileToDataUri(file, signal))
        paths.push(file)
      } catch (err) {
        logger.debug(`视频处理失败: ${err.message}`)
        uris.push("[视频异常]")
        paths.push(null)
      }
    }
    return { uris, paths }
  }

  /** 下载语音 → 缓存原文件 → silk 解码/ffmpeg 转 FLAC → data URI */
  async resolveAudio(urls, signal) {
    if (!urls?.length) return null
    const uris = []
    const paths = []
    for (const u of urls) {
      try {
        const { file } = await mediaToFile(u, { kind: "audio", maxBytes: MAX_AUDIO_DOWNLOAD, signal })
        uris.push(await audioFileToDataUri(file, signal))
        paths.push(file)
      } catch (err) {
        logger.debug(`音频处理失败: ${err.message}`)
        uris.push("[音频异常]")
        paths.push(null)
      }
    }
    return { uris, paths }
  }

  /** 接收文档类文件 → 取得本地文件路径，不编码
   *  图片/视频后缀的文件由调用方按 classifyFileExt 分流到 resolveImages/resolveVideo，
   *  与用户直接发图/视频走同一管线 */
  async resolveFiles(segs, signal) {
    if (!segs?.length) return null
    const file_paths = []
    for (const seg of segs) {
      const src = seg?.url || seg?.file
      if (!src) {
        logger.debug(`文件消息缺少可下载地址 (${seg?.name || "未知文件名"})`)
        file_paths.push(null)
        continue
      }
      try {
        const { file } = await mediaToFile(src, { kind: "file", name: seg?.name || "", maxBytes: MAX_FILE_DOWNLOAD, signal, raw: true })
        const st = await stat(file)
        if (st.size > MAX_FILE_DOWNLOAD) throw new Error(`文件过大 [${(st.size / 1024 / 1024).toFixed(1)}MB]`)
        file_paths.push(file)
      } catch (err) {
        logger.debug(`文件保存失败: ${err.message}`)
        file_paths.push(null)
      }
    }
    return { file_paths }
  }
}

export default new MediaResolver()
