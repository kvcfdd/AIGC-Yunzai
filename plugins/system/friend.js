import cfg from "../../lib/config/config.js"

export class friend extends plugin {
  constructor() {
    super({
      name: "autoFriend",
      dsc: "自动同意好友",
      event: "request.friend",
    })
  }

  async accept() {
    const { user_id, comment } = this.e
    const bot_id = this.e.self_id

    let nickname = this.e.nickname
    if (!nickname) {
      try {
        const info = await this.e.bot.pickFriend(user_id).getInfo()
        nickname = info.nickname
      } catch {}
    }

    const willAuto = (this.e.sub_type == "add" || this.e.sub_type == "single") && cfg.other.autoFriend == 1

    const msg = [segment.image(`https://q.qlogo.cn/g?b=qq&s=100&nk=${user_id}`), `\n[通知(${bot_id}) - 添加好友申请]`, `\n申请人账号：${user_id}`, `\n申请人昵称：${nickname || "未知"}`, `\n附加信息：${comment || "无"}`, `\n----------------`]

    if (willAuto) {
      msg.push(`\n已自动同意`)
    } else {
      msg.push(`\n可发送 #同意好友申请${user_id} 或 #拒绝好友申请${user_id} 进行处理`)
    }

    if (nickname) this.e.nickname = nickname

    if (cfg.other.noticeFriend !== 0) {
      Bot.sendMasterMsg(msg, undefined, 0)
    }

    if (willAuto) {
      logger.mark(`[自动同意][添加好友] ${user_id}`)
      await Bot.sleep(3000)
      this.e.approve(true)
    }
  }
}

export class friendDeal extends plugin {
  constructor() {
    super({
      name: "friendDeal",
      dsc: "处理好友申请",
      event: "message",
      priority: 10,
      rule: [
        {
          reg: /^#同意好友申请(\d+)$/,
          fnc: "agreeFriend",
          permission: "master",
        },
        {
          reg: /^#拒绝好友申请(\d+)$/,
          fnc: "rejectFriend",
          permission: "master",
        },
        {
          reg: /^#获取好友申请列表$/,
          fnc: "listFriends",
          permission: "master",
        }
      ]
    })
  }

  async agreeFriend() {
    const targetId = this.e.msg.match(/^#同意好友申请(\d+)$/)[1]
    const request = this.e.bot.request_list.find(r => r.request_type === "friend" && String(r.user_id) === targetId)
    if (!request) {
      this.e.reply(`未找到来自 ${targetId} 的待处理好友申请`)
      return
    }
    const ret = await request.approve(true).catch(err => {
      logger.error(`[同意好友申请] 失败: ${err}`)
      return false
    })
    if (ret !== false) {
      this.e.reply(`已同意 ${targetId} 的好友申请`)
      this.e.bot.request_list = this.e.bot.request_list.filter(r => r !== request)
    } else {
      this.e.reply(`同意好友申请失败，可能已过期`)
    }
  }

  async rejectFriend() {
    const targetId = this.e.msg.match(/^#拒绝好友申请(\d+)$/)[1]
    const request = this.e.bot.request_list.find(r => r.request_type === "friend" && String(r.user_id) === targetId)
    if (!request) {
      this.e.reply(`未找到来自 ${targetId} 的待处理好友申请`)
      return
    }
    const ret = await request.approve(false).catch(err => {
      logger.error(`[拒绝好友申请] 失败: ${err}`)
      return false
    })
    if (ret !== false) {
      this.e.reply(`已拒绝 ${targetId} 的好友申请`)
      this.e.bot.request_list = this.e.bot.request_list.filter(r => r !== request)
    } else {
      this.e.reply(`拒绝好友申请失败，可能已过期`)
    }
  }

  async listFriends() {
    const requests = this.e.bot.request_list.filter(r => r.request_type === "friend")

    if (!requests.length) {
      this.e.reply("暂无待处理的好友申请")
      return
    }

    await Promise.allSettled(
      requests.map(async r => {
        if (!r.nickname) {
          try {
            const info = await this.e.bot.pickFriend(r.user_id).getInfo()
            r.nickname = info.nickname
          } catch {}
        }
      }),
    )

    const forwardMsg = requests.map(r => ({
      user_id: r.user_id,
      nickname: r.nickname || String(r.user_id),
      message: [segment.image(`https://q.qlogo.cn/g?b=qq&s=100&nk=${r.user_id}`), `\n昵称：${r.nickname || "未知"}`, `\n账号：${r.user_id}`],
    }))

    const send = this.e.isGroup ? this.e.bot.pickGroup(this.e.group_id) : this.e.bot.pickFriend(this.e.user_id)

    await send.sendForwardMsg(forwardMsg)
  }
}
