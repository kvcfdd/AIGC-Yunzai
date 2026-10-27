import log from "../helpers/log.js"
import { OFFICE_MIMES, convertOfficeDoc } from "../media/office.js"
import { mediaToFile, imageFileToDataUris, videoFileToDataUri, audioFileToDataUri, fileToDataUri, MAX_IMAGE_BYTES, MAX_VIDEO_DOWNLOAD, MAX_AUDIO_DOWNLOAD, MAX_FILE_DOWNLOAD } from "../media/ingest.js"

/** 单项媒体是否已解析成功 —— 占位符([图像异常] 等)与 null 都判否 */
export const mediaResolvedOne = u => typeof u === "string" && u.startsWith("data:")

/** 媒体解析结果是否可直接复用: 全部项编码成功(data URI)，无异常占位符。
 *  打断合并复用 turn 时，被中断请求可能留下占位结果，需重新解析。
 *  图片项可能是数组(超长图切段)，任一段未解析成功即整组重解析；
 *  空数组同样判否 —— 否则会被当作已解析，静默不发任何图片部件 */
export const mediaResolved = res => !!res && (res.uris || res.files)?.every?.(u => (Array.isArray(u) ? u.length > 0 && u.every(mediaResolvedOne) : mediaResolvedOne(u)))

/** 感知层媒体预处理 — 把用户消息里的 URL/路径/data URI 变成当前请求可内联的 data URI。
 *
 *  所有方法返回 { uris, paths } 或 { files, file_paths }:
 *  - uris/files 供当前请求内联编码
 *  - paths/file_paths 为缓存文件路径 (data/aigc/chat)，供落盘时以 [xx](路径) 形式引用
 *  失败位置 uris 为占位、paths 为 null。
 */
export class MediaResolver {
  /** 将图片 URL/路径/data URI 数组预转为 data URI
   *  data URI 与 URL/路径同一管线: 落盘缓存 → 编码，动画 GIF 特化视频化
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
          log.debug(`图片处理失败: ${err.message}`)
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
        log.debug(`视频处理失败: ${err.message}`)
        uris.push("[视频异常]")
        paths.push(null)
      }
    }
    return { uris, paths }
  }

  /** 下载语音 → 缓存原文件 → silk 解码/ffmpeg 转 WAV → data URI */
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
        log.debug(`音频处理失败: ${err.message}`)
        uris.push("[音频异常]")
        paths.push(null)
      }
    }
    return { uris, paths }
  }

  /** 接收文档类文件 → 缓存原文件 → 格式识别 → data URI
   *  图片/视频后缀的文件由调用方按 classifyFileExt 分流到 resolveImages/resolveVideo，
   *  与用户直接发图/视频走同一管线
   *  OOXML 工作文档先本地预处理为白名单文本格式再发送，file_paths 仍记原件；
   *  转换失败降级为不支持提示 */
  async resolveFiles(segs, signal) {
    if (!segs?.length) return null
    const files = []
    const file_paths = []
    for (const seg of segs) {
      const src = seg?.url || seg?.file
      if (!src) {
        log.debug(`文件消息缺少可下载地址 (${seg?.name || "未知文件名"})`)
        files.push("[文件异常]")
        file_paths.push(null)
        continue
      }
      const name = seg?.name || ""
      try {
        const { file, mime } = await mediaToFile(src, { kind: "file", name, maxBytes: MAX_FILE_DOWNLOAD, signal })
        if (!mime || !file) {
          files.push("[文件格式不支持查看]")
          file_paths.push(null)
          continue
        }
        if (OFFICE_MIMES.has(mime)) {
          const conv = await convertOfficeDoc(file, mime)
          if (!conv) {
            files.push("[文件格式不支持查看]")
            file_paths.push(null)
            continue
          }
          files.push(`data:${conv.mime};base64,${Buffer.from(conv.text, "utf8").toString("base64")}`)
          file_paths.push(file)
          continue
        }
        files.push(await fileToDataUri(file, mime))
        file_paths.push(file)
      } catch (err) {
        log.debug(`文件处理失败: ${err.message}`)
        files.push("[文件异常]")
        file_paths.push(null)
      }
    }
    return { files, file_paths }
  }
}

export default new MediaResolver()
