import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import cfg from "../../config/config.js"
import { expandParams } from "./schema.js"
import { imageToDataUri } from "../provider.js"

const MAX_NAME_LEN = 64
const NAME_RE = /[^a-zA-Z0-9_-]/g

/** 工具名清理: 去非法字符 → 限长 → 保证唯一 */
function sanitize(name) {
  let cleaned = String(name)
    .replace(NAME_RE, "_")
    .replace(/^_+|_+$/g, "")
  if (!cleaned) cleaned = "x"
  if (cleaned.length <= MAX_NAME_LEN) return cleaned

  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  }
  const suffix = "_" + Math.abs(hash).toString(36).slice(0, 6)
  return cleaned.slice(0, MAX_NAME_LEN - suffix.length) + suffix
}

/** 权限校验 */
function checkPermission(perm, e) {
  if (!perm || perm === "all") return true
  if (e.isMaster) return true
  if (perm === "master") return false
  if (!e.isGroup) return false
  const isOwner = e.member?.is_owner || e.member?.role === "owner"
  const isAdmin = e.member?.is_admin || e.member?.role === "admin" || e.member?.role === "owner"

  if (perm === "owner" && !isOwner) return false
  if (perm === "admin" && !isAdmin) return false
  return true
}

const PERM_MSG = {
  master: "仅 bot 主人可用",
  owner: "仅群主可用",
  admin: "仅群管理员可用",
}

/** 同步事件上下文到子对象 */
function syncEventContext(inst, e) {
  inst.e = e
  for (const key of Object.keys(inst)) {
    try {
      const val = inst[key]
      if (val && typeof val === "object" && "e" in val && !val.e) {
        val.e = e
      }
    } catch {
      /* pass */
    }
  }
}

/** From reply 参数中提取图片并转为 data URI */
async function extractImages(replyArgs) {
  try {
    const msg = replyArgs[0]
    if (!msg) return []

    const segments = Array.isArray(msg) ? msg : [msg]
    const images = []

    for (const seg of segments) {
      if (seg?.type !== "image") continue
      try {
        const file = seg.file
        const url = seg.url
        if (Buffer.isBuffer(file)) {
          images.push(`data:image/png;base64,${file.toString("base64")}`)
          continue
        }
        if (typeof file === "string" && file.startsWith("base64://")) {
          images.push(`data:image/png;base64,${file.slice(9)}`)
          continue
        }
        if (typeof file === "string" && (file.startsWith("http://") || file.startsWith("https://"))) {
          images.push(await imageToDataUri(file))
          continue
        }
        if (typeof url === "string" && url.startsWith("data:")) {
          images.push(url)
          continue
        }
        if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
          images.push(await imageToDataUri(url))
          continue
        }
        if (typeof file === "string" && file) {
          let filePath = file
          if (filePath.startsWith("file://")) {
            filePath = fileURLToPath(filePath)
          }
          filePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)
          const buf = await fs.readFile(filePath)
          const ext = path.extname(filePath).slice(1).toLowerCase()
          const mimeMap = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            webp: "image/webp",
            gif: "image/gif",
            bmp: "image/bmp",
          }
          const mime = mimeMap[ext] || "image/png"
          images.push(`data:${mime}base64,${buf.toString("base64")}`)
        }
      } catch {
        images.push("[图像异常]")
      }
    }

    return images
  } catch {
    return []
  }
}

/**
 * 将插件最小声明展开为完整 Tool 定义
 */
export function expandToolDef(pluginKey, ClassName, decl) {
  const pluginId = pluginKey.replace(/[/\\]/g, "_").replace(/\.[^.]+$/, "")
  const toolName = sanitize(`${pluginId}_${decl.fnc}`)
  const parameters = expandParams(decl.params)

  const permNote = decl.permission && decl.permission !== "all" ? ` [需要权限: ${decl.permission}]` : ""
  const description = (decl.description || "") + permNote

  const execute = async (args, ctx) => {
    const e = ctx?.event
    if (!e) return "无法获取消息上下文"

    if (decl.permission && decl.permission !== "all") {
      if (!checkPermission(decl.permission, e)) {
        return PERM_MSG[decl.permission] || `权限不足 (需要 ${decl.permission})`
      }
    }

    let inst
    try {
      inst = new ClassName()
    } catch {
      return "插件实例化失败"
    }
    syncEventContext(inst, e)
    if (!e.original_msg) e.original_msg = e.msg

    if (typeof inst[decl.fnc] !== "function") {
      return `插件方法不存在: ${decl.fnc}`
    }
    let didReply = false
    const replyArgsList = []

    const createProxyReply = orig => {
      if (typeof orig !== "function") return undefined
      return (...a) => {
        didReply = true
        replyArgsList.push(a)
        return orig(...a)
      }
    }

    const origReply = inst.reply?.bind(inst)
    if (origReply) inst.reply = createProxyReply(origReply)

    const origEReply = e.reply?.bind(e)
    if (origEReply) e.reply = createProxyReply(origEReply)

    try {
      const result = await inst[decl.fnc](args, ctx)

      const collectImages = async () => {
        try {
          return (await Promise.all(replyArgsList.map(extractImages))).flat()
        } catch {
          return []
        }
      }

      const imgs = await collectImages()
      const hasCustomResult = result !== undefined && result !== null && result !== true && result !== false
      if (hasCustomResult) {
        if (imgs.length) {
          const text = typeof result === "string" ? result : JSON.stringify(result)
          return { images: imgs, text }
        }
        return result
      }
      if (decl.reply || didReply) {
        return imgs.length ? { images: imgs, text: "[已发送]" } : "[已发送]"
      }

      return result ?? "[完成]"
    } catch (err) {
      return `执行失败: ${err.message}`
    } finally {
      if (origReply) inst.reply = origReply
      if (origEReply) e.reply = origEReply
    }
  }

  return { name: toolName, description, parameters, execute }
}
