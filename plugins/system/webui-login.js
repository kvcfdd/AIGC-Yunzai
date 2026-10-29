import { randomBytes } from "node:crypto"

export default class WebUILogin extends plugin {
  constructor() {
    super({
      name: "配置控制台登录",
      dsc: "生成 WebUI 临时登录密钥",
      event: "message",
      priority: 4000,
      rule: [{ reg: /^#登[录陆]$/i, fnc: "login" }],
    })
  }

  async login() {
    if (!this.e.isMaster) return true
    if (!globalThis.redis) return true

    const currentKey = `webui:login:current:${this.e.user_id}`
    const old = await globalThis.redis.get(currentKey)
    if (old) await globalThis.redis.del(`webui:login:${old}`)

    const key = randomBytes(16).toString("base64url")
    await globalThis.redis.set(`webui:login:${key}`, "1", { EX: 600 })
    await globalThis.redis.set(currentKey, key, { EX: 600 })

    if (this.e.isPrivate) return this.reply(key)
    try {
      const friend = this.e.friend || this.e.bot?.pickFriend?.(this.e.user_id)
      if (!friend?.sendMsg) throw new Error("无法打开私聊")
      await friend.sendMsg(key)
    } catch (err) {
      globalThis.logger?.warn?.(`WebUI 登录密钥私聊发送失败: ${err.message}`)
    }
    return true
  }
}
