import tools from "./registry.js"
import { mediaToFile, imageFileToDataUri, MAX_IMAGE_BYTES } from "../provider/media.js"
import PluginsLoader from "../../plugins/loader.js"
import log from "../helpers/log.js"
import path from "node:path"
import { mkdir, writeFile, unlink } from "node:fs/promises"

/** 非文本段 → 返回文本中的占位标注 */
const PLACEHOLDER = {
  record: "[语音]",
  audio: "[语音]",
  face: "[表情]",
  video: "[视频]",
  forward: "[转发消息]",
  node: "[转发消息]",
  at: "[@用户]",
  reply: "[引用]",
  file: "[文件]",
  xml: "[卡片]",
  json: "[卡片]",
}

/** 递归提取图片地址：支持 oicq 段、CQ 风格段、miao 双层包裹段、Buffer 载荷 */
function extractImageUrl(seg) {
  if (!seg || typeof seg !== "object") return null
  for (const v of [seg.url, seg.file, seg.data?.url, seg.data?.file]) {
    if (typeof v === "string" && v) return v
    if (Buffer.isBuffer(v)) return `base64://${v.toString("base64")}`
  }
  for (const v of [seg.file, seg.url, seg.data]) {
    if (v && typeof v === "object" && !Buffer.isBuffer(v)) {
      const inner = extractImageUrl(v)
      if (inner) return inner
    }
  }
  return null
}

/** 图片地址 → { images, paths }：
 *  data URI 直通；
 *  base64:// 解码落临时文件后经 mediaToFile 复制入缓存，用完清理临时文件；
 *  其余直接 mediaToFile 落盘缓存 + sharp 转 data URI */
async function urlToImageData(url, signal) {
  if (typeof url !== "string" || !url) throw new Error("图片地址无效")
  if (url.startsWith("data:")) return { images: [url], paths: [null] }

  let source = url
  let tmp = null
  if (url.startsWith("base64://")) {
    await mkdir(path.resolve("data/aigc/tmp"), { recursive: true })
    tmp = path.resolve("data/aigc/tmp", `run_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.img`)
    await writeFile(tmp, Buffer.from(url.slice(9), "base64"))
    source = tmp
  }
  try {
    const { file } = await mediaToFile(source, { kind: "image", maxBytes: MAX_IMAGE_BYTES, signal })
    if (!file) throw new Error("图片落盘失败")
    return { images: [await imageFileToDataUri(file)], paths: [file] }
  } finally {
    if (tmp) await unlink(tmp).catch(() => {})
  }
}

/** 指令执行超时：插件 handler 挂住时放弃等待，防对话卡死 */
const CMD_TIMEOUT = 10_000

/** 给 promise 加超时/中止竞争；settled 后自动清理定时器与监听。
 *  超时或中止时触发 onTimeout */
export function withDeadline(promise, { ms, signal, onTimeout }) {
  return new Promise((resolve, reject) => {
    let timer = null
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      cleanup()
      onTimeout?.()
      reject(new DOMException("Aborted", "AbortError"))
    }
    timer = setTimeout(() => {
      cleanup()
      onTimeout?.()
      reject(new Error(`指令执行超时(${Math.round(ms / 1000)}s)，已放弃等待；插件可能仍在后台运行`))
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
    promise.then(
      v => {
        cleanup()
        resolve(v)
      },
      e => {
        cleanup()
        reject(e)
      },
    )
  })
}

tools.register({
  name: "run_cmd",
  description: "以用户身份执行指令触发来自 bot 框架插件的功能：传入指令文本（如 #今日运势），效果等同用户自己发送。指令写法先查对应插件的 skill 文档（SKILL.md），不要凭空猜测指令。不支持多轮/上下文类指令；同类指令不要重复调用。",
  parameters: {
    type: "object",
    properties: {
      cmd: {
        type: "string",
        description: "指令文本，与用户直接发送的完整指令相同。不确定写法时先调用 skill 工具查看对应插件的 SKILL.md。",
      },
    },
    required: ["cmd"],
  },
  execute: async (args, ctx) => {
    const cmd = args?.cmd
    if (typeof cmd !== "string" || !cmd.trim()) return "参数 cmd 缺失：请传入要执行的指令文本"
    const src = ctx?.event
    if (!src?.reply) return "指令执行失败：缺少会话事件上下文"

    const e = { ...src }
    const texts = []
    const images = []
    const image_paths = []
    let expired = false

    // 覆写合成事件的 reply：捕获插件回复并分流
    e.reply = async (msg = "", quote = false) => {
      if (expired) return false
      if (!msg) return false
      if (typeof msg === "string") {
        texts.push(msg)
        return true
      }
      const segs = Array.isArray(msg) ? msg : [msg]
      const toSend = []
      for (const seg of segs) {
        if (!seg || typeof seg !== "object") {
          texts.push(String(seg))
          continue
        }
        if (seg.type === "text") {
          texts.push(seg.data?.text ?? seg.text ?? "")
          continue
        }
        if (seg.type === "button" || seg.type === "keyboard") continue
        if (seg.type === "image") {
          toSend.push(seg)
          const url = extractImageUrl(seg)
          if (url) {
            try {
              const r = await urlToImageData(url, ctx?.signal)
              images.push(...r.images)
              image_paths.push(...r.paths)
            } catch (err) {
              texts.push(`[图片获取失败: ${err.message}]`)
            }
          } else {
            texts.push("[图片]")
          }
          continue
        }
        toSend.push(seg)
        texts.push(PLACEHOLDER[seg.type] || "[其他消息段]")
      }
      if (toSend.length) await src.reply(toSend, quote)
      return true
    }

    log.info(`run_cmd <${cmd.trim()}>`)
    let matched = false
    try {
      matched = await withDeadline(PluginsLoader.dealCommand(e, cmd), {
        ms: CMD_TIMEOUT,
        signal: ctx?.signal,
        onTimeout: () => (expired = true),
      })
    } catch (err) {
      if (err?.name === "AbortError") {
        log.info(`run_cmd <${cmd.trim()}> 被中断`)
        return "指令执行被中断"
      }
      log.error(`run_cmd 执行异常: ${err.message}`)
      return `指令执行失败: ${err.message}`
    }
    if (!matched) return `未找到匹配指令 ${cmd.trim()}。可调用 skill 工具查看插件技能文档（SKILL.md）确认指令写法`

    const text = texts.join("\n") || "指令执行完成"
    if (images.length) return { images, image_paths, text }
    return text
  },
})
