import fs from "node:fs"
import path from "node:path"
import { execFile, exec } from "node:child_process"
import { pipeline } from "node:stream/promises"
import log from "./log.js"
import util from "node:util"
import cfg from "../../config/config.js"

const execAsync = util.promisify(exec)
const execFileAsync = util.promisify(execFile)

const downloaderConfig = { aria2cConcurrency: 8 }
const toolCheckCache = {}

/** 检测外部命令行工具是否可用 */
export async function isToolInstalled(toolName) {
  if (toolCheckCache[toolName] !== undefined) return toolCheckCache[toolName]
  try {
    await execAsync(`${toolName} --version`)
    log.debug(`检测到外部工具: ${toolName}`)
    toolCheckCache[toolName] = true
    return true
  } catch {
    log.warn(`未找到外部工具: ${toolName}`)
    toolCheckCache[toolName] = false
    return false
  }
}

/** 使用 FFmpeg 合并视频和音频 */
export async function mergeVideoAndAudio(videoPath, audioPath, outputPath) {
  log.debug(`开始合并视频`)
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-c",
      "copy",
      outputPath,
    ])
  } catch (err) {
    log.error(`视频合并失败: ${err.stderr || err.message}`)
    if (err.code === "ENOENT") {
      throw new Error(
        "FFmpeg not found. Please ensure FFmpeg is installed and accessible in your system's PATH.",
      )
    }
    throw new Error(`FFmpeg failed to merge files: ${err.stderr || err.message}`)
  }
}

/** aria2c 多线程下载 */
export async function downloadWithAria2c(videoUrl, audioUrl, videoPath, audioPath, headers) {
  log.debug(`使用 aria2c 下载视频`)
  const concurrency = downloaderConfig.aria2cConcurrency.toString()

  const baseArgs = ["-x", concurrency, "-s", concurrency, "--allow-overwrite=true"]
  for (const [key, value] of Object.entries(headers)) {
    baseArgs.push(`--header=${key}: ${value}`)
  }

  await Promise.all([
    execFileAsync("aria2c", [
      ...baseArgs,
      "-o",
      path.basename(videoPath),
      "-d",
      path.dirname(videoPath),
      videoUrl,
    ]),
    execFileAsync("aria2c", [
      ...baseArgs,
      "-o",
      path.basename(audioPath),
      "-d",
      path.dirname(audioPath),
      audioUrl,
    ]),
  ])

  log.debug(`aria2c 下载完成`)
}

/** Node.js fetch 流式下载 */
export async function downloadWithNativeFetch(videoUrl, audioUrl, videoPath, audioPath, headers) {
  log.debug(`使用 fetch 下载视频`)

  const downloadStream = async (url, filePath) => {
    const response = await fetch(url, { headers })
    if (!response.ok) throw new Error(`Download failed: ${response.statusText}`)
    await pipeline(response.body, fs.createWriteStream(filePath))
  }

  await Promise.all([downloadStream(videoUrl, videoPath), downloadStream(audioUrl, audioPath)])
  log.debug(`fetch 下载完成`)
}

/** 获取 B站视频信息（标题、封面、音视频流地址等） */
export async function getBilibili(bvid) {
  try {
    const biliCookie = cfg.aigc?.bilibili_cookie || ""
    const apiHeaders = {
      accept: "*/*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
      origin: "https://www.bilibili.com",
      Referer: `https://www.bilibili.com/video/${bvid}`,
      "sec-ch-ua": '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0",
      Cookie: biliCookie,
    }

    const videoInfoRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: apiHeaders,
    })
    if (!videoInfoRes.ok)
      throw new Error(`Bilibili view API request failed with status ${videoInfoRes.status}`)
    const videoInfo = await videoInfoRes.json()
    if (videoInfo.code !== 0) throw new Error(`Bilibili view API error: ${videoInfo.message}`)
    const { cid, aid, title, pic, desc, owner, stat, pubdate, honor_reply } = videoInfo.data

    const downloadInfoRes = await fetch(
      `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16`,
      { headers: apiHeaders },
    )
    if (!downloadInfoRes.ok)
      throw new Error(`Bilibili playurl API request failed with status ${downloadInfoRes.status}`)
    const downloadInfo = await downloadInfoRes.json()
    if (downloadInfo.code !== 0)
      throw new Error(`Bilibili playurl API error: ${downloadInfo.message}`)

    const videoStream = downloadInfo.data?.dash?.video?.[0]
    const audioStream = downloadInfo.data?.dash?.audio?.[0]

    // 获取流体积，超过 50MB 则仅发送信息不下载
    let totalSize = 0
    try {
      if (videoStream?.baseUrl) {
        const vRes = await fetch(videoStream.baseUrl, { method: "HEAD", headers: apiHeaders })
        totalSize += parseInt(vRes.headers.get("content-length"), 10) || 0
      }
      if (audioStream?.baseUrl) {
        const aRes = await fetch(audioStream.baseUrl, { method: "HEAD", headers: apiHeaders })
        totalSize += parseInt(aRes.headers.get("content-length"), 10) || 0
      }
    } catch (err) {
      log.debug(`获取视频大小失败: ${err.message}`)
    }

    return {
      arcurl: `https://www.bilibili.com/video/av${aid}`,
      title,
      pic,
      description: desc,
      videoUrl: videoStream?.baseUrl,
      audioUrl: audioStream?.baseUrl,
      headers: apiHeaders,
      bvid,
      author: owner.name,
      play: stat.view,
      pubdate,
      like: stat.like,
      honor: honor_reply?.honor?.map(h => h.desc)?.join("、"),
      totalSize,
    }
  } catch (err) {
    log.error(`获取B站视频信息失败: ${err.message}`)
    return null
  }
}
