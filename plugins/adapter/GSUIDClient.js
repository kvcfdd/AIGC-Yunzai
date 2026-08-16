import WebSocket from "ws"
import cfg from "../../lib/config/config.js"

// 合并转发标记与展开深度上限
const NODE_MARK = "[合并转发]"
const NODE_MAX_DEPTH = 3

Bot.adapter.push(
  new (class GSUIDClientAdapter {
    id = "GSUIDClient"
    name = "早柚核心"
    ws = null
    status = 0
    reconnect = null

    getCfg() {
      return cfg.gsuid || {}
    }

    routeId() {
      const url = String(this.getCfg().url || "").split("?")[0]
      return url.split("/").filter(Boolean).pop() || ""
    }

    makeLog(msg) {
      return Bot.String(msg).replace(/base64:\/\/.*?"/g, 'base64://..."')
    }

    // 用户权限
    getPm(e) {
      let user_pm = 6
      const isMaster = e.isMaster || cfg.master?.[String(e.self_id)]?.includes?.(String(e.user_id))
      if (isMaster) user_pm = 1
      else if (e.group_id) {
        const role = e.sender?.role || e.member?.role
        if (role === "owner") user_pm = 2
        else if (role === "admin") user_pm = 3
      }
      return user_pm
    }

    // 优先取适配器解析好的 source_message 里的纯文本
    plainText(source) {
      if (!Array.isArray(source)) return ""
      return source
        .filter(i => i?.type === "text")
        .map(i => i.text ?? "")
        .join("")
    }

    // 在引用链里找合并转发
    findForward(source) {
      if (!Array.isArray(source)) return null
      for (const i of source) {
        if (i?.type === "forward") return i.id ?? i.data?.id ?? null
        if (i?.type === "node" && (i.id || i.data?.id)) return i.id ?? i.data?.id
      }
      return null
    }

    // 合并转发摘要
    nodePreview(items) {
      const lines = [NODE_MARK]
      for (const i of items) {
        if (i.type === "text" && i.data) {
          const text = String(i.data).trim()
          if (text) lines.push(text)
        } else if (i.type === "image") lines.push("[图片]")
        else if (i.type === "record") lines.push("[语音]")
        else if (i.type === "video") lines.push("[视频]")
        else if (i.type === "file") lines.push("[文件]")
      }
      return lines.join("\n")
    }

    // OneBot 转发节点 → GsCore 扁平 List<Message>
    async forwardNode(e, id, depth = 0, seen = new Set()) {
      if (!id || seen.has(String(id)) || depth >= NODE_MAX_DEPTH) return [{ type: "text", data: NODE_MARK }]
      seen.add(String(id))
      let msgs
      try {
        const target = e.group_id ? e.bot?.pickGroup?.(e.group_id) : e.bot?.pickFriend?.(e.user_id)
        msgs = await target?.getForwardMsg?.(id)
      } catch {}
      if (!Array.isArray(msgs) || !msgs.length) return [{ type: "text", data: NODE_MARK }]
      const items = []
      for (const entry of msgs) {
        if (entry?.type === "node") {
          items.push({ type: "text", data: NODE_MARK })
          const fid = entry.id ?? entry.data?.id
          if (fid) items.push(...(await this.forwardNode(e, fid, depth + 1, seen)))
          continue
        }
        const nickname = entry?.sender?.nickname || entry?.name || entry?.data?.name
        if (nickname) items.push({ type: "text", data: `${nickname}:` })
        const content = entry?.message || entry?.content
        if (typeof content === "string" && content) items.push({ type: "text", data: content })
        else if (Array.isArray(content)) items.push(...(await this.segmentsToNode(content, e, depth, seen)))
      }
      return items.length ? items : [{ type: "text", data: NODE_MARK }]
    }

    // OneBot 段 → GsCore 扁平段
    async segmentsToNode(segs, e, depth, seen) {
      const items = []
      for (const seg of Array.isArray(segs) ? segs : []) {
        const type = seg?.type
        if (type === "text") {
          const text = seg.text ?? seg.data?.text
          if (text) items.push({ type: "text", data: String(text) })
        } else if (type === "image") {
          const url = seg.url || seg.file || seg.data?.url || seg.data?.file
          if (url) items.push({ type: "image", data: url })
        } else if (type === "at") {
          const qq = seg.qq ?? seg.data?.qq
          if (qq) items.push({ type: "at", data: String(qq) })
        } else if (type === "record") {
          const data = seg.url || seg.file || seg.data?.url || seg.data?.file
          if (data) items.push({ type: "record", data })
        } else if (type === "forward" || type === "forward_msg") {
          const fid = seg.id ?? seg.data?.id
          items.push({ type: "text", data: NODE_MARK })
          if (fid) items.push(...(await this.forwardNode(e, fid, depth + 1, seen)))
        } else if (type === "node") {
          const fid = seg.id ?? seg.data?.id
          if (fid) {
            items.push({ type: "text", data: NODE_MARK })
            items.push(...(await this.forwardNode(e, fid, depth + 1, seen)))
          } else {
            const content = seg.content ?? seg.data?.content
            if (Array.isArray(content)) items.push(...(await this.segmentsToNode(content, e, depth, seen)))
          }
        }
      }
      return items
    }

    // 上报消息
    async report(e) {
      const current = []
      const quotedImage = []
      let replyId = null
      let replyText = ""
      let replySource = []

      for (const i of e.message || []) {
        switch (i.type) {
          case "text":
            current.push({ type: "text", data: i.text })
            break
          case "at":
            current.push({ type: "at", data: String(i.qq) })
            break
          case "image":
            if (i.url || i.file) (i.sub_type === "reply" ? quotedImage : current).push({ type: "image", data: i.url || i.file })
            break
          case "reply": {
            replyId = String(i.id)
            replySource = i.source_message || []
            replyText = this.plainText(replySource) || i.text || ""
            break
          }
          case "forward": {
            const node = await this.forwardNode(e, i.id)
            if (node.length) current.push({ type: "node", data: node })
            break
          }
          case "record":
            if (i.url || i.file) current.push({ type: "record", data: i.url || i.file })
            break
          case "file": {
            if (!e.group_id && i.url) {
              let file = await Bot.Buffer(i.url, { http: true, size: 10485760 })
              if (Buffer.isBuffer(file)) file = `${(i.name || "file").replace(/\|/g, "_")}|${file.toString("base64")}`
              if (typeof file === "string" && file.includes("|")) current.push({ type: "file", data: file })
            }
            break
          }
          case "json":
            current.push({ type: "json", data: JSON.stringify(i.data) })
            break
          default:
            break
        }
      }

      // 引用上下文附在当前消息之后
      const quoted = []
      if (replyId != null) {
        quoted.push({ type: "reply_id", data: replyId })
        const fid = this.findForward(replySource)
        const node = fid != null ? await this.forwardNode(e, fid) : null
        let text = replyText
        if (node?.length) {
          if (!text) text = this.nodePreview(node)
          else if (!text.includes(NODE_MARK)) text = `${NODE_MARK}\n${text}`
          quoted.push({ type: "reply", data: text })
          quoted.push({ type: "node", data: node })
        } else if (text) {
          quoted.push({ type: "reply", data: text })
        }
      }
      const content = [...current, ...quoted, ...quotedImage]
      if (content.length === 0) return false

      // 头像
      let avatar
      try {
        const user = e.group_id ? e.bot?.pickMember?.(e.group_id, e.user_id) : e.bot?.pickFriend?.(e.user_id)
        avatar = await user?.getAvatarUrl?.()
      } catch {}

      return {
        bot_id: this.getCfg().bot_id,
        bot_self_id: String(e.self_id),
        msg_id: String(e.message_id || ""),
        user_id: String(e.user_id),
        user_pm: this.getPm(e),
        content,
        sender: {
          ...(e.sender || {}),
          user_id: String(e.user_id),
          ...(avatar ? { avatar } : {}),
        },
        user_type: e.group_id ? "group" : "direct",
        ...(e.group_id ? { group_id: String(e.group_id) } : {}),
      }
    }

    // 内容转换
    async makeSendMsg(content) {
      const sendMsg = []
      for (const msg of content || []) {
        switch (msg.type) {
          case "text":
            sendMsg.push(msg.data)
            break
          case "image": {
            let data = msg.data
            if (!/^(http|base64|link)/.test(data)) data = `base64://${data}`
            else if (data.startsWith("link://")) {
              data = data.replace("link://", "")
              if (!data.startsWith("http")) data = `http://${data}`
            }
            sendMsg.push(segment.image(data))
            break
          }
          case "at":
            sendMsg.push(segment.at(Number(msg.data) || String(msg.data)))
            break
          case "reply":
          case "reply_id":
            sendMsg.push({ type: "reply", id: String(msg.data) })
            break
          case "json":
            sendMsg.push({ type: "json", data: msg.data })
            break
          case "node": {
            const nodes = []
            for (const item of msg.data || []) {
              const message = await this.makeSendMsg(Array.isArray(item?.content) ? item.content : [item])
              if (message.length)
                nodes.push({
                  message,
                  ...(item?.nickname ? { nickname: item.nickname } : {}),
                  ...(item?.user_id ? { user_id: item.user_id } : {}),
                })
            }
            if (nodes.length) sendMsg.push({ type: "node", data: nodes })
            break
          }
          case "markdown":
            sendMsg.push(segment.markdown(msg.data))
            break
          case "record":
            sendMsg.push(segment.record(msg.data))
            break
          case "video":
            sendMsg.push(segment.video(msg.data))
            break
          case "buttons":
          case "template_buttons":
          case "template_markdown":
            Bot.makeLog("warn", `当前协议端不支持 ${msg.type} 消息，已跳过`)
            break
          default:
            break
        }
      }
      return sendMsg
    }

    // 从发送返回值提取平台 msg_id
    pickMsgId(ret) {
      let mid = ret?.message_id ?? ret?.data?.message_id
      if (Array.isArray(mid)) mid = mid.filter(i => i != null).map(String)
      else if (mid != null) mid = String(mid)
      return mid
    }

    // recall_message_id 上行包
    receipt(data, ids) {
      if (!this.ws || this.status !== 1) return
      let id = null
      if (ids.length === 1) id = ids[0]
      else if (ids.length > 1) id = ids
      const msg = {
        bot_id: data.bot_id,
        bot_self_id: data.bot_self_id,
        content: [{ type: "recall_message_id", data: { echo: data.echo, id } }],
      }
      try {
        this.ws.send(Buffer.from(JSON.stringify(msg)))
      } catch {}
    }

    // 下发消息
    async send(data) {
      const ids = []
      try {
        const bot = Bot[data.bot_self_id] || Bot
        const isDirect = data.target_type === "direct"
        const target = isDirect ? bot.pickFriend(data.target_id) : bot.pickGroup(data.target_id)
        if (!target) return Bot.makeLog("error", ["发送目标不存在", data.target_type, data.target_id], data.bot_self_id)

        const sendMsg = []
        for (const msg of data.content || []) {
          if (msg.type === "file") {
            const [name, content] = String(msg.data).split("|")
            if (!content) {
              Bot.makeLog("warn", ["文件数据格式错误", this.makeLog(msg.data)], data.bot_self_id)
              continue
            }
            const file = content.startsWith("link://") ? await Bot.Buffer(content.slice(7), { http: true, size: 10485760 }) : Buffer.from(content, "base64")
            const ret = await target.sendFile?.(file, name.replace(/\|/g, "_") || "file")
            const mid = this.pickMsgId(ret)
            if (Array.isArray(mid)) ids.push(...mid)
            else if (mid != null) ids.push(mid)
            continue
          }
          sendMsg.push(...(await this.makeSendMsg([msg])))
        }

        if (sendMsg.length) {
          Bot.makeLog("debug", `发送${isDirect ? "好友" : "群"}消息：${this.makeLog(sendMsg)}`, `${data.bot_self_id} => ${data.target_id}`, true)
          const ret = await target.sendMsg(sendMsg)
          const mid = this.pickMsgId(ret)
          if (Array.isArray(mid)) ids.push(...mid)
          else if (mid != null) ids.push(mid)
        }
      } finally {
        if (data.echo) this.receipt(data, ids)
      }
    }

    // 撤回控制包
    async recall(data) {
      const mid = data.content[0].data?.message_id
      if (mid == null) return
      const bot = Bot[data.bot_self_id] || Bot
      const target = data.target_type === "direct" ? bot.pickFriend?.(data.target_id) : bot.pickGroup?.(data.target_id)
      if (!target?.recallMsg) return Bot.makeLog("warn", ["当前协议端不支持撤回", data.content[0].data], data.bot_self_id)
      await target.recallMsg(String(mid)).catch(err => Bot.makeLog("error", ["撤回失败", mid, err], data.bot_self_id))
    }

    // 禁言控制包
    async ban(data) {
      const { user_id, group_id, duration } = data.content[0].data || {}
      if (user_id == null || group_id == null) return
      if (!(Number.isInteger(duration) || (typeof duration === "string" && /^\d+$/.test(duration)))) return
      const bot = Bot[data.bot_self_id] || Bot
      const group = bot.pickGroup?.(String(group_id))
      if (!group?.muteMember) return Bot.makeLog("warn", ["当前协议端不支持禁言", data.content[0].data], data.bot_self_id)
      await group.muteMember(Number(user_id), Number(duration)).catch(err => Bot.makeLog("error", ["禁言失败", user_id, err], data.bot_self_id))
    }

    // 接收核心下发的指令
    async message(data) {
      try {
        data = JSON.parse(Buffer.isBuffer(data) ? data.toString() : data)
      } catch (err) {
        return Bot.makeLog("error", ["解码数据失败", data, err])
      }
      const first = data.content?.[0]
      if (first?.type?.startsWith?.("log") && (!this.routeId() || data.bot_id === this.routeId())) {
        const level = first.type.split("_")[1]?.toLowerCase() || "info"
        const map = { info: "info", warning: "warn", error: "error", success: "mark" }
        logger[map[level] || "info"](first.data)
        return
      }
      if (data.content?.length === 1) {
        if (first.type === "excute_delete_message") return await this.recall(data)
        if (first.type === "excute_ban_user") return await this.ban(data)
      }
      await this.send(data).catch(err => Bot.makeLog("error", ["发送指令执行失败", data, err], data?.bot_self_id))
    }

    // 元事件上报
    async onMeta(e, name) {
      const { enable, forward_self_msg } = this.getCfg()
      if (!enable) return
      if (!forward_self_msg && String(e.user_id) === String(e.self_id)) return
      if (!this.ws) this.connect()
      if (this.status !== 1 || !this.ws) return

      let data = {}
      if (name === "poke") {
        data = {
          user_id: String(e.user_id),
          target_id: e.target_id != null ? String(e.target_id) : String(e.self_id),
          ...(e.group_id ? { group_id: String(e.group_id) } : {}),
        }
      } else {
        data = {
          user_id: String(e.user_id),
          group_id: String(e.group_id),
          ...(e.operator_id != null ? { operator_id: String(e.operator_id) } : {}),
        }
      }
      const msg = {
        bot_id: this.getCfg().bot_id,
        bot_self_id: String(e.self_id),
        msg_id: "",
        user_type: e.group_id ? "group" : "direct",
        ...(e.group_id ? { group_id: String(e.group_id) } : {}),
        user_id: String(e.user_id),
        sender: e.sender || {},
        user_pm: this.getPm(e),
        content: [{ type: `meta-${name}`, data }],
      }
      Bot.makeLog("debug", ["上报元事件", name, data], `${e.self_id} <= ${e.user_id}`, true)
      this.ws.send(Buffer.from(JSON.stringify(msg)))
    }

    // 上报过滤
    noReport(start, end, e) {
      const starts = Array.isArray(start) ? start.filter(Boolean) : []
      const ends = Array.isArray(end) ? end.filter(Boolean) : []
      if (!starts.length && !ends.length) return false
      const text = (e.message || [])
        .filter(i => i?.type === "text")
        .map(i => i.text)
        .join("")
      const startMatch = starts.some(i => text.startsWith(String(i)))
      const endMatch = ends.some(i => text.endsWith(String(i)))
      if (starts.length && ends.length) return startMatch && endMatch
      return startMatch || endMatch
    }

    // 本项目消息事件 → 主动上报给早柚核心
    async onMessage(e) {
      const { enable, forward_self_msg, no_report_start, no_report_end } = this.getCfg()
      if (!e.user_id) return
      if (!enable) {
        // 关闭时断开已有连接，不再上报
        if (this.status === 1) this.ws?.close()
        return
      }
      // 未连接时尝试连接
      if (!this.ws) this.connect()
      if (this.status !== 1 || !this.ws) return
      // 过滤机器人自己发出的消息，防止回声循环
      if (!forward_self_msg && e.user_id === e.self_id) return
      // 开头/结尾过滤
      if (this.noReport(no_report_start, no_report_end, e)) return
      const report = await this.report(e).catch(err => Bot.makeLog("error", ["上报消息失败", err], e.self_id))
      if (!report) return
      Bot.makeLog("debug", ["上报消息", this.makeLog(report)], `${e.self_id} <= ${e.user_id}`, true)
      this.ws.send(Buffer.from(JSON.stringify(report)))
    }

    // 连接早柚核心
    connect() {
      clearTimeout(this.reconnect)
      if (!this.getCfg().enable) return
      const { url, token } = this.getCfg()
      const address = token ? `${url}${url.includes("?") ? "&" : "?"}token=${token}` : url
      try {
        this.ws = new WebSocket(address)
      } catch (err) {
        return Bot.makeLog("error", ["早柚核心地址错误", address, err], this.id)
      }
      this.ws.on("open", () => {
        this.status = 1
        Bot.makeLog("mark", `早柚核心已连接：${address}`, this.id)
      })
      this.ws.on("message", data => this.message(data))
      this.ws.on("close", code => {
        this.status = 0
        const { enable, reconnect_interval } = this.getCfg()
        Bot.makeLog("warn", `早柚核心已断开：${code}${enable ? `，${reconnect_interval}秒后重连` : ""}`, this.id)
        if (enable) this.reconnect = setTimeout(() => this.connect(), reconnect_interval * 1000)
      })
      this.ws.on("error", () => {})
    }

    load() {
      if (this.getCfg().enable) this.connect()
      Bot.on("message", e => this.onMessage(e))
      Bot.on("notice.group.increase", e => this.onMeta(e, "user_join_group"))
      Bot.on("notice.group.decrease", e => this.onMeta(e, "user_exit_group"))
      Bot.on("notice.notify.poke", e => this.onMeta(e, "poke"))
      Bot.on("notice.friend.poke", e => this.onMeta(e, "poke"))
      Bot.on("notice.group.poke", e => this.onMeta(e, "poke"))
    }
  })(),
)
