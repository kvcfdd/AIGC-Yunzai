import cfg from "../../lib/config/config.js"

export class invite extends plugin {
  constructor() {
    super({
      name: "invite",
      dsc: "邀请自动进群",
      event: "request.group.invite",
    })
  }

  async accept() {
    const { group_id, user_id } = this.e
    const bot_id = this.e.self_id

    let groupName = this.e.group_name
    let nickname = this.e.nickname
    try {
      if (!groupName) {
        const info = await this.e.bot.pickGroup(group_id).getInfo()
        groupName = info.group_name
      }
      if (!nickname) {
        const info = await this.e.bot.pickFriend(user_id).getInfo()
        nickname = info.nickname
      }
    } catch {}

    const willAuto = this.e.isMaster || cfg.other.autoGroup === 1

    const msg = [segment.image(`https://p.qlogo.cn/gh/${group_id}/${group_id}/100`), `\n[通知(${bot_id}) - 群邀请]`, `\n群号：${group_id}`, `\n群名：${groupName || "未知"}`, `\n邀请人账号：${user_id}`, `\n邀请人昵称：${nickname || "未知"}`, `\n----------------`]

    if (willAuto) {
      msg.push(`\n已自动同意`)
    } else {
      msg.push(`\n可发送 #同意群邀请${group_id} 或 #拒绝群邀请${group_id} 进行处理`)
    }

    if (groupName) this.e.group_name = groupName
    if (nickname) this.e.nickname = nickname

    if (cfg.other.noticeGroup !== 0) {
      Bot.sendMasterMsg(msg, undefined, 0)
    }

    if (!willAuto) {
      logger.mark(`[邀请加群]：${groupName}：${group_id}`)
      return
    }
    logger.mark(`[${this.e.isMaster ? "主人" : "自动同意"}邀请加群]：${groupName}：${group_id}`)
    this.e.approve(true)
    this.e.bot.pickFriend(this.e.user_id).sendMsg(`已同意加群：${groupName}`)
  }
}

export class inviteDeal extends plugin {
  constructor() {
    super({
      name: "inviteDeal",
      dsc: "处理群邀请",
      event: "message",
      priority: 10,
      rule: [
        {
          reg: /^#同意群邀请(\d+)$/,
          fnc: "agreeInvite",
          permission: "master",
        },
        {
          reg: /^#拒绝群邀请(\d+)$/,
          fnc: "rejectInvite",
          permission: "master",
        },
        {
          reg: /^#获取群邀请列表$/,
          fnc: "listInvites",
          permission: "master",
        },
      ],
    })
  }

  async agreeInvite() {
    const targetId = this.e.msg.match(/^#同意群邀请(\d+)$/)[1]
    const request = this.e.bot.request_list.find(r => r.request_type === "group" && String(r.group_id) === targetId)
    if (!request) {
      this.e.reply(`未找到群 ${targetId} 的待处理群邀请`)
      return
    }
    const ret = await request.approve(true).catch(err => {
      logger.error(`[同意群邀请] 失败: ${err}`)
      return false
    })
    if (ret !== false) {
      this.e.reply(`已同意加入群 ${targetId}`)
      this.e.bot.request_list = this.e.bot.request_list.filter(r => r !== request)
    } else {
      this.e.reply(`同意群邀请失败，可能已过期`)
    }
  }

  async rejectInvite() {
    const targetId = this.e.msg.match(/^#拒绝群邀请(\d+)$/)[1]
    const request = this.e.bot.request_list.find(r => r.request_type === "group" && String(r.group_id) === targetId)
    if (!request) {
      this.e.reply(`未找到群 ${targetId} 的待处理群邀请`)
      return
    }
    const ret = await request.approve(false, "拒绝邀请").catch(err => {
      logger.error(`[拒绝群邀请] 失败: ${err}`)
      return false
    })
    if (ret !== false) {
      this.e.reply(`已拒绝加入群 ${targetId}`)
      this.e.bot.request_list = this.e.bot.request_list.filter(r => r !== request)
    } else {
      this.e.reply(`拒绝群邀请失败，可能已过期`)
    }
  }

  async listInvites() {
    const requests = this.e.bot.request_list.filter(r => r.request_type === "group" && r.sub_type === "invite")
    try {
      const res = await this.e.bot.getGroupSystemMsg(50)
      const data = res?.data || res
      const apiInvites = data?.invited_requests || []
      for (const inv of apiInvites) {
        const gid = String(inv.group_code || inv.group_id)
        if (!requests.some(r => String(r.group_id) === gid)) {
          requests.push({
            user_id: inv.invitor_uin || inv.invitor_uid,
            nickname: inv.invitor_nick || inv.invitor_nickname,
            group_id: gid,
            group_name: inv.group_name,
          })
        }
      }
    } catch {
      logger.debug("[获取群邀请列表] API查询失败，仅使用内存列表")
    }

    if (!requests.length) {
      this.e.reply("暂无待处理的群邀请")
      return
    }

    await Promise.allSettled(
      requests.map(async r => {
        try {
          if (!r.group_name) {
            const info = await this.e.bot.pickGroup(r.group_id).getInfo()
            r.group_name = info.group_name
          }
          if (!r.nickname) {
            const info = await this.e.bot.pickFriend(r.user_id).getInfo()
            r.nickname = info.nickname
          }
        } catch {}
      }),
    )

    const forwardMsg = requests.map(r => ({
      user_id: r.user_id || this.e.self_id,
      nickname: r.nickname || String(r.user_id || this.e.self_id),
      message: [segment.image(`https://p.qlogo.cn/gh/${r.group_id}/${r.group_id}/100`), `\n群名：${r.group_name || "未知"}`, `\n群号：${r.group_id}`, `\n邀请人昵称：${r.nickname || "未知"}`, `\n邀请人账号：${r.user_id}`],
    }))

    const send = this.e.isGroup ? this.e.bot.pickGroup(this.e.group_id) : this.e.bot.pickFriend(this.e.user_id)

    await send.sendForwardMsg(forwardMsg)
  }
}
