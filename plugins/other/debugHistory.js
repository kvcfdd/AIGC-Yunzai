import plugin from "../../lib/plugins/plugin.js"
import fs from "node:fs/promises"
import path from "node:path"

export class ExportChat extends plugin {
  constructor() {
    super({
      name: "导出群聊天记录",
      dsc: "导出最近N条群聊天记录原始JSON",
      event: "message",
      priority: -Infinity,
      rule: [
        {
          reg: "^#导出(聊天|群聊)?记录\\s*(\\d+)?\\s*(\\d+)?$",
          fnc: "exportChat",
          permission: "master",
        },
      ],
    })
  }

  async exportChat() {
    const nums = this.e.msg.match(/\d+/g) || []
    let groupId, count

    if (nums.length >= 2) {
      groupId = nums[0]
      count = Number(nums[1])
    } else if (this.e.isGroup) {
      groupId = this.e.group_id
      count = nums[0] ? Number(nums[0]) : 100
    } else {
      if (nums.length < 1) return this.reply("私聊请指定群号: #导出聊天记录 群号 [数量]", true)
      groupId = nums[0]
      count = nums[1] ? Number(nums[1]) : 100
    }
    count = Math.min(count, 500)

    const group = Bot.pickGroup(groupId)
    if (!group?.getChatHistory) {
      return this.reply(`群 ${groupId} 不存在或适配器不支持获取聊天记录`, true)
    }

    let msgSeq
    if (this.e.isGroup && this.e.group_id == groupId) {
      msgSeq = this.e.message_seq
    }

    await this.reply(`正在获取群 ${groupId} 最近 ${count} 条聊天记录...`, true)

    let msgs
    try {
      msgs = await group.getChatHistory(msgSeq, count, true)
    } catch (err) {
      return this.reply(`获取聊天记录失败: ${err.message}`, true)
    }
    if (!msgs?.length) {
      return this.reply("未获取到聊天记录", true)
    }

    const dump = msgs.map(msg => ({
      message_id: msg.message_id,
      time: msg.time,
      user_id: msg.user_id,
      sender: msg.sender,
      raw_message: msg.raw_message,
      message: msg.message,
    }))

    const content = JSON.stringify(dump, null, 2)
    const dir = "data/chat_export"
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    const file = path.join(dir, `${groupId}_${Date.now()}.json`)
    await fs.writeFile(file, content, "utf-8")

    const sendTarget = this.e.isGroup ? this.e.group : this.e.friend
    try {
      await sendTarget.sendFile?.(file, `chat_${groupId}.json`)
    } catch {
      await this.reply(`已保存至 ${file} （当前适配器不支持直接发送文件）`, true)
    }
  }
}
