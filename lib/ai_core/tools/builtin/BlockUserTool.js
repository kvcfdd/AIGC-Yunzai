import tools from "../tool-registry.js"
import { isMaster } from "../workspace.js"

const ACTIONS = new Set(["block", "unblock"])

/** 读取当前 QQ 黑名单 */
function currentBlacklist(config) {
  const list = config?.aigc?.qq_blacklist
  return Array.isArray(list) ? list.map(String) : []
}

tools.register(
  {
    name: "block_user",
    description: "Block (屏蔽) or unblock a QQ user; blocked users' messages are ignored by the bot.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["block", "unblock"] },
        user_id: { type: "string", description: "QQ number; defaults to the current user." },
      },
      required: ["action"],
    },
    execute: async (args, ctx) => {
      const action = String(args?.action || "")
        .trim()
        .toLowerCase()
      if (!ACTIONS.has(action)) throw new Error("action must be block or unblock")

      const selfId = String(ctx?.event?.user_id ?? "").trim()
      const requested = args?.user_id == null ? "" : String(args.user_id).trim()
      const target = requested || selfId
      if (!target) throw new Error("无法确定目标账号")
      const botId = String(ctx?.event?.self_id ?? "").trim()
      if (botId && target === botId) throw new Error("不能屏蔽 bot 自身")
      if (!isMaster(ctx) && target !== selfId) throw new Error("权限不足：只有 bot owner 可以屏蔽其他账号")

      const config = ctx?.config
      if (typeof config?.setConfig !== "function") throw new Error("当前运行环境不支持修改配置")

      const list = new Set(currentBlacklist(config))
      const blocked = list.has(target)
      if (action === "block" && blocked) return `用户 ${target} 已在屏蔽列表中`
      if (action === "unblock" && !blocked) return `用户 ${target} 未被屏蔽`

      if (action === "block") list.add(target)
      else list.delete(target)
      config.setConfig("aigc", "qq_blacklist", [...list])

      const saved = new Set(currentBlacklist(config))
      const ok = action === "block" ? saved.has(target) : !saved.has(target)
      if (!ok) throw new Error("屏蔽状态写入失败，请检查 config/config/aigc.yaml 是否可写")

      return action === "block" ? `已屏蔽用户 ${target}：其消息将不再触发回复` : `已解除屏蔽用户 ${target}`
    },
  },
  { deferred: true },
)
