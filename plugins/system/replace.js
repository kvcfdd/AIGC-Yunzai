import loader from "../../lib/plugins/loader.js"

export class replace extends plugin {
  constructor() {
    super({
      name: "代发言",
      dsc: "代替指定QQ发言",
      event: "message",
      priority: 10,
      rule: [
        {
          reg: "^#?代(.*)",
          fnc: "replace",
        },
      ],
    })
  }

  async replace() {
    const bot = this.e.bot || Bot
    if (!this.e.msg || !this.e.isMaster || !bot) return false

    let e = this.e
    let at = e.at
    let msg = ""

    if (at) {
      let reg = /^#?代\s*(.*)$/.exec(e.msg)
      if (reg) msg = reg[1]?.trim()
    } else {
      let reg = /^#?代\s*(\d+)\s*(.*)$/.exec(e.msg)
      if (reg) {
        at = Number(reg[1])
        msg = reg[2]?.trim()
      } else {
        return false
      }
    }

    if (!at) return false
    at = Number(at)

    let message = []
    let isFirstText = true

    if (e.message) {
      for (let val of e.message) {
        if (val.type === "at" && val.qq == at) {
          continue
        }
        if (val.type === "text" && isFirstText) {
          let text = val.text
          if (e.at) {
            text = text.replace(/^#?代\s*/, "")
          } else {
            text = text.replace(new RegExp(`^#?代\\s*${at}\\s*`), "")
          }
          text = text.trim()
          if (text) {
            message.push({ type: "text", text: text })
          }
          isFirstText = false
        } else {
          message.push(val)
        }
      }
    }

    message.unshift(segment.at(e.self_id))
    msg = msg?.trim()

    if (e.replyNew) e.reply = e.replyNew

    const new_e = {
      friend: e.friend,
      isPrivate: e.isPrivate,
      atall: e.atall,
      atme: e.atme,
      block: e.block,
      font: e.font,
      from_id: at,
      group: e.group,
      group_id: e.group_id,
      group_name: e.group_name,
      isGroup: e.isGroup,
      isMaster: false,
      member: e.group?.pickMember(at) || {},
      message: message,
      message_id: e.message_id,
      message_type: e.message_type,
      msg_id: e.msg_id,
      nt: e.nt,
      original_msg: msg,
      post_type: e.post_type,
      rand: e.rand,
      raw_message: msg,
      recall: e.recall,
      reply: e.reply,
      self_id: e.self_id,
      sender: {},
      seq: e.seq,
      sub_type: e.sub_type,
      time: e.time,
      user_id: at,
    }

    new_e.sender = new_e.member?.info || {
      card: at,
      nickname: at,
      user_id: at,
    }

    try {
      if (loader.groupGlobalCD) delete loader.groupGlobalCD[e.group_id]
      if (loader.groupCD) delete loader.groupCD[e.group_id]
    } catch {}

    try {
      bot.em("message", { ...new_e })
    } catch {
      loader.deal({ ...new_e })
    }
    return true
  }
}
