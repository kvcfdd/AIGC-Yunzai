import cfg from "../../lib/config/config.js"
import path from "node:path"
import { ulid } from "ulid"

Bot.adapter.push(
  new (class OneBotv11Adapter {
    id = "QQ"
    name = "OneBotv11"
    path = this.name
    echo = new Map()
    timeout = 180000
    seen = new Map()
    seenTimeout = 100

    makeLog(msg) {
      return Bot.String(msg).replace(/base64:\/\/.*?(,|]|")/g, "base64://...$1")
    }

    sendApi(data, ws, action, params = {}) {
      const echo = ulid()
      const request = { action, params, echo }
      ws.sendMsg(request)
      const cache = Promise.withResolvers()
      this.echo.set(echo, cache)
      const timeout = setTimeout(() => {
        cache.reject(Bot.makeError("请求超时", request, { timeout: this.timeout }))
        Bot.makeLog("error", ["请求超时", request], data.self_id)
      }, this.timeout)

      return cache.promise
        .then(data =>
          data.data
            ? new Proxy(data, {
                get: (target, prop) => target.data[prop] ?? target[prop],
              })
            : data,
        )
        .finally(() => {
          clearTimeout(timeout)
          this.echo.delete(echo)
        })
    }

    async makeFile(file, opts) {
      file = await Bot.Buffer(file, { http: true, size: 10485760, ...opts })
      if (Buffer.isBuffer(file)) return `base64://${file.toString("base64")}`
      return file
    }

    async makeMsg(msg) {
      if (!Array.isArray(msg)) msg = [msg]
      const msgs = []
      const forward = []
      for (let i of msg) {
        if (typeof i !== "object") i = { type: "text", data: { text: i } }
        else if (!i.data) i = { type: i.type, data: { ...i, type: undefined } }

        switch (i.type) {
          case "at":
            i.data.qq = String(i.data.qq)
            break
          case "reply":
            i.data.id = String(i.data.id)
            break
          case "button":
            continue
          case "node":
            forward.push(...i.data)
            continue
          case "raw":
            i = i.data
            break
        }

        if (i.data.file) i.data.file = await this.makeFile(i.data.file)
        msgs.push(i)
      }
      return [msgs, forward]
    }

    async sendMsg(msg, send, sendForwardMsg) {
      const [message, forward] = await this.makeMsg(msg)
      const ret = []
      if (forward.length) {
        const data = await sendForwardMsg(forward)
        if (Array.isArray(data)) ret.push(...data)
        else ret.push(data)
      }
      if (message.length) ret.push(await send(message))
      if (ret.length === 1) return ret[0]
      const message_id = []
      for (const i of ret) if (i?.message_id) message_id.push(i.message_id)
      return { data: ret, message_id }
    }

    // 发送私聊消息
    sendFriendMsg(data, msg) {
      return this.sendMsg(
        msg,
        message => {
          Bot.makeLog("info", `发送好友消息：${this.makeLog(message)}`, `${data.self_id} => ${data.user_id}`, true)
          return data.bot.sendApi("send_private_msg", { user_id: data.user_id, message })
        },
        msg => this.sendFriendForwardMsg(data, msg),
      )
    }

    // 发送群消息
    sendGroupMsg(data, msg) {
      return this.sendMsg(
        msg,
        message => {
          Bot.makeLog("info", `发送群消息：${this.makeLog(message)}`, `${data.self_id} => ${data.group_id}`, true)
          return data.bot.sendApi("send_group_msg", { group_id: data.group_id, message })
        },
        msg => this.sendGroupForwardMsg(data, msg),
      )
    }

    // 撤回消息
    async recallMsg(data, message_id) {
      Bot.makeLog("info", `撤回消息：${message_id}`, data.self_id)
      if (!Array.isArray(message_id)) message_id = [message_id]
      const msgs = []
      for (const i of message_id) msgs.push(await data.bot.sendApi("delete_msg", { message_id: i }).catch(e => e))
      return msgs
    }

    parseMsg(msg) {
      const array = []
      for (const i of Array.isArray(msg) ? msg : [msg])
        if (typeof i === "object") array.push({ ...i.data, type: i.type })
        else array.push({ type: "text", text: String(i) })
      return array
    }

    // 获取消息
    async getMsg(data, message_id) {
      const msg = (await data.bot.sendApi("get_msg", { message_id })).data
      if (msg?.message) msg.message = this.parseMsg(msg.message)
      return msg
    }

    // 获取好友历史消息
    async getFriendMsgHistory(data, message_seq, count, reverseOrder = true) {
      const msgs = (
        await data.bot.sendApi("get_friend_msg_history", {
          user_id: data.user_id,
          message_seq,
          count,
          reverseOrder,
        })
      ).data?.messages
      for (const i of Array.isArray(msgs) ? msgs : [msgs]) if (i?.message) i.message = this.parseMsg(i.message)
      return msgs
    }

    // 获取群历史消息
    async getGroupMsgHistory(data, message_seq, count, reverseOrder = true) {
      const msgs = (
        await data.bot.sendApi("get_group_msg_history", {
          group_id: data.group_id,
          message_seq,
          count,
          reverseOrder,
        })
      ).data?.messages
      for (const i of Array.isArray(msgs) ? msgs : [msgs]) if (i?.message) i.message = this.parseMsg(i.message)
      return msgs
    }

    // 获取合并转发消息
    async getForwardMsg(data, message_id) {
      const msgs = (await data.bot.sendApi("get_forward_msg", { message_id })).data?.messages
      for (const i of Array.isArray(msgs) ? msgs : [msgs]) if (i?.message) i.message = this.parseMsg(i.message || i.content)
      return msgs
    }

    async makeForwardMsg(msg, data) {
      const nickname = data?.bot?.info?.nickname
      const userId = data?.bot?.info?.user_id
      const msgs = []
      for (const i of msg) {
        const [content, forward] = await this.makeMsg(i.message)
        if (forward.length) msgs.push(...(await this.makeForwardMsg(forward, data)))
        if (content.length)
          msgs.push({
            type: "node",
            data: {
              name: i.nickname || nickname || "匿名消息",
              uin: String(Number(i.user_id) || userId || 80000000),
              content,
              time: i.time,
            },
          })
      }
      return msgs
    }

    // 发送私聊合并转发消息
    async sendFriendForwardMsg(data, msg) {
      Bot.makeLog("info", `发送好友转发消息：${this.makeLog(msg)}`, `${data.self_id} => ${data.user_id}`, true)
      const messages = await this.makeForwardMsg(msg, data)
      return data.bot.sendApi("send_private_forward_msg", {
        user_id: data.user_id,
        message: messages,
        messages,
      })
    }

    // 发送群合并转发消息
    async sendGroupForwardMsg(data, msg) {
      Bot.makeLog("info", `发送群转发消息：${this.makeLog(msg)}`, `${data.self_id} => ${data.group_id}`, true)
      const messages = await this.makeForwardMsg(msg, data)
      return data.bot.sendApi("send_group_forward_msg", {
        group_id: data.group_id,
        message: messages,
        messages,
      })
    }

    // 获取好友列表
    async getFriendArray(data) {
      return (await data.bot.sendApi("get_friend_list")).data || []
    }
    async getFriendList(data) {
      return (await this.getFriendArray(data)).map(i => i.user_id)
    }
    async getFriendMap(data) {
      const map = new Map()
      for (const i of await this.getFriendArray(data)) map.set(i.user_id, i)
      data.bot.fl = map
      return map
    }

    // 获取陌生人信息
    async getFriendInfo(data, no_cache = false) {
      const info = (await data.bot.sendApi("get_stranger_info", { user_id: data.user_id, no_cache })).data
      if (data.bot.fl.has(data.user_id)) data.bot.fl.set(data.user_id, info)
      return info
    }

    // 获取群列表
    async getGroupArray(data) {
      return (await data.bot.sendApi("get_group_list")).data || []
    }
    async getGroupList(data) {
      return (await this.getGroupArray(data)).map(i => i.group_id)
    }
    async getGroupMap(data) {
      const map = new Map()
      for (const i of await this.getGroupArray(data)) map.set(i.group_id, i)
      data.bot.gl = map
      return map
    }

    // 获取群信息
    async getGroupInfo(data, no_cache = false) {
      const info = (await data.bot.sendApi("get_group_info", { group_id: data.group_id, no_cache })).data
      data.bot.gl.set(data.group_id, info)
      return info
    }

    // 获取群成员列表
    async getMemberArray(data) {
      return (await data.bot.sendApi("get_group_member_list", { group_id: data.group_id })).data || []
    }
    async getMemberList(data) {
      return (await this.getMemberArray(data)).map(i => i.user_id)
    }
    async getMemberMap(data) {
      const map = new Map()
      for (const i of await this.getMemberArray(data)) map.set(i.user_id, i)
      data.bot.gml.set(data.group_id, map)
      return map
    }

    async getGroupMemberMap(data) {
      if (!cfg.bot.cache_group_member) return this.getGroupMap(data)
      for (const [group_id] of await this.getGroupMap(data)) await this.getMemberMap({ ...data, group_id })
    }
    // 获取群成员信息
    async getMemberInfo(data, no_cache = false) {
      const info = (
        await data.bot.sendApi("get_group_member_info", {
          group_id: data.group_id,
          user_id: data.user_id,
          no_cache,
        })
      ).data
      let gml = data.bot.gml.get(data.group_id)
      if (!gml) {
        gml = new Map()
        data.bot.gml.set(data.group_id, gml)
      }
      gml.set(data.user_id, info)
      return info
    }

    // 设置QQ资料
    setProfile(data, profile) {
      Bot.makeLog("info", `设置资料：${Bot.String(profile)}`, data.self_id)
      return data.bot.sendApi("set_qq_profile", profile)
    }

    // 设置QQ头像
    async setAvatar(data, file) {
      Bot.makeLog("info", `设置头像：${file}`, data.self_id)
      return data.bot.sendApi("set_qq_avatar", { file: await this.makeFile(file) })
    }

    // 点赞
    sendLike(data, times = 10) {
      Bot.makeLog("info", `点赞：${times}次`, `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("send_like", { user_id: data.user_id, times })
    }

    // 设置群名称
    setGroupName(data, group_name) {
      Bot.makeLog("info", `设置群名：${group_name}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_name", { group_id: data.group_id, group_name })
    }

    // 设置群头像
    async setGroupAvatar(data, file) {
      Bot.makeLog("info", `设置群头像：${file}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_portrait", {
        group_id: data.group_id,
        file: await this.makeFile(file),
      })
    }

    // 设置群管理员
    setGroupAdmin(data, user_id, enable) {
      Bot.makeLog("info", `${enable ? "设置" : "取消"}群管理员：${user_id}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_admin", { group_id: data.group_id, user_id, enable })
    }

    // 设置群名片
    setGroupCard(data, user_id, card) {
      Bot.makeLog("info", `设置群名片：${card}`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_card", { group_id: data.group_id, user_id, card })
    }

    // 设置专属头衔
    setGroupTitle(data, user_id, special_title, duration) {
      Bot.makeLog("info", `设置群头衔：${special_title} ${duration}`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_special_title", {
        group_id: data.group_id,
        user_id,
        special_title,
        duration,
      })
    }

    // 群打卡
    sendGroupSign(data) {
      Bot.makeLog("info", "群打卡", `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("send_group_sign", { group_id: data.group_id })
    }

    // 群组禁言
    setGroupBan(data, user_id, duration) {
      Bot.makeLog("info", `禁言群成员：${duration}秒`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_ban", { group_id: data.group_id, user_id, duration })
    }

    // 全员禁言
    setGroupWholeKick(data, enable) {
      Bot.makeLog("info", `${enable ? "开启" : "关闭"}全员禁言`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_whole_ban", { group_id: data.group_id, enable })
    }

    // 群组踢人
    setGroupKick(data, user_id, reject_add_request) {
      Bot.makeLog("info", `踢出群成员${reject_add_request ? "拒绝再次加群" : ""}`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_kick", {
        group_id: data.group_id,
        user_id,
        reject_add_request,
      })
    }

    // 退出群组
    setGroupLeave(data, is_dismiss) {
      Bot.makeLog("info", is_dismiss ? "解散" : "退群", `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_leave", { group_id: data.group_id, is_dismiss })
    }

    // 设置好友备注
    setFriendRemark(data, remark) {
      Bot.makeLog("info", `设置好友备注：${remark}`, `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("set_friend_remark", { user_id: data.user_id, remark })
    }

    // 设置群备注
    setGroupRemark(data, remark) {
      Bot.makeLog("info", `设置群备注：${remark}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_remark", { group_id: data.group_id, remark })
    }

    // 上传私聊文件
    async sendFriendFile(data, file, name = path.basename(file)) {
      Bot.makeLog("info", `发送好友文件：${name}(${file})`, `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("upload_private_file", {
        user_id: data.user_id,
        file: (await this.makeFile(file, { file: true })).replace("file://", ""),
        name,
      })
    }

    // 上传群文件
    async sendGroupFile(data, file, folder, name = path.basename(file)) {
      Bot.makeLog("info", `发送群文件：${folder || ""}/${name}(${file})`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("upload_group_file", {
        group_id: data.group_id,
        folder,
        file: (await this.makeFile(file, { file: true })).replace("file://", ""),
        name,
      })
    }

    // 删除群文件
    deleteGroupFile(data, file_id, busid) {
      Bot.makeLog("info", `删除群文件：${file_id}(${busid})`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("delete_group_file", { group_id: data.group_id, file_id, busid })
    }

    // 创建群文件目录
    createGroupFileFolder(data, name) {
      Bot.makeLog("info", `创建群文件夹：${name}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("create_group_file_folder", { group_id: data.group_id, folder_name: name })
    }

    // 获取群文件系统信息
    getGroupFileSystemInfo(data) {
      return data.bot.sendApi("get_group_file_system_info", { group_id: data.group_id })
    }

    // 获取群文件夹文件列表
    getGroupFiles(data, folder_id, file_count = 50) {
      if (folder_id)
        return data.bot.sendApi("get_group_files_by_folder", {
          group_id: data.group_id,
          folder_id,
          file_count,
        })
      return data.bot.sendApi("get_group_root_files", { group_id: data.group_id, file_count })
    }

    // 获取群文件URL
    getGroupFileUrl(data, file_id, busid) {
      return data.bot.sendApi("get_group_file_url", { group_id: data.group_id, file_id, busid })
    }

    // 获取私聊文件URL
    async getPrivateFileUrl(data, file_id) {
      const res = await data.bot.sendApi("get_private_file_url", {
        user_id: data.user_id,
        file_id,
      })
      return res?.data?.url ?? res?.url
    }

    getGroupFs(data) {
      return {
        upload: this.sendGroupFile.bind(this, data),
        rm: this.deleteGroupFile.bind(this, data),
        mkdir: this.createGroupFileFolder.bind(this, data),
        df: this.getGroupFileSystemInfo.bind(this, data),
        ls: this.getGroupFiles.bind(this, data),
        download: this.getGroupFileUrl.bind(this, data),
        move: this.moveGroupFile.bind(this, data),
        rename: this.renameGroupFile.bind(this, data),
        trans: this.transGroupFile.bind(this, data),
        rmdir: this.deleteGroupFolder.bind(this, data),
      }
    }

    // 删除好友
    deleteFriend(data) {
      Bot.makeLog("info", "删除好友", `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("delete_friend", { user_id: data.user_id }).finally(this.getFriendMap.bind(this, data))
    }

    // 处理加好友请求
    setFriendAddRequest(data, flag, approve, remark) {
      return data.bot.sendApi("set_friend_add_request", { flag, approve, remark })
    }

    // 处理加群请求
    setGroupAddRequest(data, flag, approve, reason, sub_type = "add") {
      return data.bot.sendApi("set_group_add_request", { flag, sub_type, approve, reason })
    }

    // 获取群荣誉信息
    getGroupHonorInfo(data) {
      return data.bot.sendApi("get_group_honor_info", { group_id: data.group_id })
    }

    // 获取群精华消息列表
    getEssenceMsg(data) {
      return data.bot.sendApi("get_essence_msg_list", { group_id: data.group_id })
    }
    // 设置精华消息
    setEssenceMsg(data, message_id) {
      return data.bot.sendApi("set_essence_msg", { message_id })
    }
    // 移出精华消息
    deleteEssenceMsg(data, message_id) {
      return data.bot.sendApi("delete_essence_msg", { message_id })
    }

    // 发送戳一戳
    sendPoke(data, group_id, user_id) {
      const target_id = user_id ?? data.user_id
      Bot.makeLog("info", `发送戳一戳：${target_id}`, group_id ? `${data.self_id} => ${group_id}` : `${data.self_id} => ${target_id}`, true)
      if (group_id) return data.bot.sendApi("group_poke", { group_id, user_id: target_id })
      return data.bot.sendApi("friend_poke", { user_id: target_id })
    }

    // 设置消息表情点赞
    setMsgEmojiLike(data, message_id, emoji_id, set = true) {
      return data.bot.sendApi("set_msg_emoji_like", { message_id, emoji_id, set })
    }

    // 发送群公告
    sendGroupNotice(data, content, image) {
      return data.bot.sendApi("_send_group_notice", {
        group_id: data.group_id,
        content,
        image,
      })
    }
    // 获取群公告
    getGroupNotice(data) {
      return data.bot.sendApi("_get_group_notice", { group_id: data.group_id })
    }
    // 删除群公告
    delGroupNotice(data, notice_id) {
      return data.bot.sendApi("_del_group_notice", { group_id: data.group_id, notice_id })
    }

    // 发表QQ空间说说
    async sendQzoneMsg(data, content, images = [], ugc_right = 1, target_uins = []) {
      Bot.makeLog("info", `发表QQ空间说说：${Bot.String(content).slice(0, 50)}${images.length ? ` (${images.length}张图)` : ""}`, data.self_id)
      return data.bot.sendApi("send_qzone_msg", {
        content,
        images: await Promise.all(images.map(f => this.makeFile(f))),
        ugc_right,
        target_uins,
      })
    }

    // 删除QQ空间说说
    deleteQzoneMsg(data, tid) {
      Bot.makeLog("info", `删除QQ空间说说：${tid}`, data.self_id)
      return data.bot.sendApi("delete_qzone_msg", { tid })
    }

    // 标记群聊已读
    markGroupRead(data) {
      return data.bot.sendApi("mark_group_msg_as_read", { group_id: data.group_id })
    }
    // 标记私聊已读
    markPrivateRead(data) {
      return data.bot.sendApi("mark_private_msg_as_read", { user_id: data.user_id })
    }

    // 获取群@全体剩余次数
    getGroupAtAllRemain(data) {
      return data.bot.sendApi("get_group_at_all_remain", { group_id: data.group_id })
    }

    // 获取最近会话
    getRecentContact(data, count = 10) {
      return data.bot.sendApi("get_recent_contact", { count })
    }

    // 获取群系统消息
    getGroupSystemMsg(data, count = 50) {
      return data.bot.sendApi("get_group_system_msg", { count })
    }

    // 获取群禁言列表
    getGroupShutList(data) {
      return data.bot.sendApi("get_group_shut_list", { group_id: data.group_id })
    }

    // 设置群加群选项
    setGroupAddOption(data, option) {
      return data.bot.sendApi("set_group_add_option", { group_id: data.group_id, ...option })
    }

    // 设置群待办
    setGroupTodo(data, params) {
      return data.bot.sendApi("set_group_todo", { group_id: data.group_id, ...params })
    }

    // 获取群详细信息
    getGroupInfoEx(data) {
      return data.bot.sendApi("get_group_info_ex", { group_id: data.group_id })
    }

    // 获取群忽略通知列表
    getGroupIgnoredNotifies(data) {
      return data.bot.sendApi("get_group_ignored_notifies", {})
    }

    // 设置在线状态
    setOnlineStatus(data, status) {
      const params = typeof status === "object" ? status : { status }
      return data.bot.sendApi("set_online_status", { status: 11, ext_status: 0, battery_status: 0, ...params })
    }

    // 设置自定义在线状态
    setDiyOnlineStatus(data, face_id, face_type = 1, wording = "") {
      return data.bot.sendApi("set_diy_online_status", { face_id, face_type, wording })
    }

    // 设置个性签名
    setSelfLongnick(data, longNick) {
      Bot.makeLog("info", `设置个性签名：${longNick}`, data.self_id)
      return data.bot.sendApi("set_self_longnick", { longNick })
    }

    // 获取资料卡点赞
    getProfileLike(data, start = 0, count = 10, user_id) {
      return data.bot.sendApi("get_profile_like", { start, count, user_id })
    }

    // 获取带分组的好友列表
    getFriendsWithCategory(data) {
      return data.bot.sendApi("get_friends_with_category", {})
    }

    // 图片OCR识别
    ocrImage(data, image) {
      return data.bot.sendApi("ocr_image", { image })
    }

    // 转发单条消息给好友
    forwardFriendSingleMsg(data, user_id, message_id) {
      return data.bot.sendApi("forward_friend_single_msg", { user_id, message_id })
    }

    // 转发单条消息到群
    forwardGroupSingleMsg(data, group_id, message_id) {
      return data.bot.sendApi("forward_group_single_msg", { group_id, message_id })
    }

    // 获取可疑好友申请
    getDoubtFriendsAddRequest(data, count = 50) {
      return data.bot.sendApi("get_doubt_friends_add_request", { count })
    }

    // 处理可疑好友申请
    setDoubtFriendsAddRequest(data, params) {
      return data.bot.sendApi("set_doubt_friends_add_request", params)
    }

    // 删除群文件目录
    deleteGroupFolder(data, folder_id) {
      return data.bot.sendApi("delete_group_folder", { group_id: data.group_id, folder_id })
    }

    // 创建收藏
    createCollection(data, params) {
      return data.bot.sendApi("create_collection", params)
    }

    // 获取收藏列表
    getCollectionList(data, params) {
      return data.bot.sendApi("get_collection_list", { category: "0", count: "50", ...params })
    }

    // 获取群详细信息
    getGroupDetailInfo(data) {
      return data.bot.sendApi("get_group_detail_info", { group_id: data.group_id })
    }

    // 批量踢出群成员
    setGroupKickMembers(data, user_ids, reject_add_request) {
      return data.bot.sendApi("set_group_kick_members", {
        group_id: data.group_id,
        user_id: user_ids,
        reject_add_request,
      })
    }

    // 设置输入状态
    setInputStatus(data, params) {
      const payload = typeof params === "object" ? params : { event_type: params }
      return data.bot.sendApi("set_input_status", { user_id: data.user_id, ...payload })
    }

    // 设置群签到
    setGroupSign(data, params) {
      return data.bot.sendApi("set_group_sign", { group_id: data.group_id, ...params })
    }

    // 获取群签到列表
    getGroupSignedList(data) {
      return data.bot.sendApi("get_group_signed_list", { group_id: data.group_id })
    }

    // 完成群待办
    completeGroupTodo(data, params) {
      return data.bot.sendApi("complete_group_todo", { group_id: data.group_id, ...params })
    }

    // 取消群待办
    cancelGroupTodo(data, params) {
      return data.bot.sendApi("cancel_group_todo", { group_id: data.group_id, ...params })
    }

    // 移动群文件
    moveGroupFile(data, params) {
      return data.bot.sendApi("move_group_file", { group_id: data.group_id, ...params })
    }

    // 重命名群文件
    renameGroupFile(data, params) {
      return data.bot.sendApi("rename_group_file", { group_id: data.group_id, ...params })
    }

    // 转存群文件
    transGroupFile(data, params) {
      return data.bot.sendApi("trans_group_file", { group_id: data.group_id, ...params })
    }

    // 获取表情回应详情
    fetchEmojiLike(data, params) {
      return data.bot.sendApi("fetch_emoji_like", params)
    }

    // 获取消息表情回应列表
    getEmojiLikes(data, params) {
      return data.bot.sendApi("get_emoji_likes", params)
    }

    // 发送群聊 ARK 分享
    sendGroupArkShare(data, params) {
      return data.bot.sendApi("send_group_ark_share", { group_id: data.group_id, ...params })
    }

    // 发送私聊 ARK 分享
    sendArkShare(data, params) {
      return data.bot.sendApi("send_ark_share", { user_id: data.user_id, ...params })
    }

    // 设置群机器人加群选项
    setGroupRobotAddOption(data, params) {
      return data.bot.sendApi("set_group_robot_add_option", { group_id: data.group_id, ...params })
    }

    // 设置群搜索状态
    setGroupSearch(data, params) {
      return data.bot.sendApi("set_group_search", { group_id: data.group_id, ...params })
    }

    // 语音转文字
    fetchPttText(data, params) {
      return data.bot.sendApi("fetch_ptt_text", params)
    }

    // 获取小程序 ARK
    getMiniAppArk(data, params) {
      return data.bot.sendApi("get_mini_app_ark", params)
    }

    // 获取群相册列表
    getQunAlbumList(data, attach_info = "") {
      return data.bot.sendApi("get_qun_album_list", { group_id: data.group_id, attach_info })
    }

    // 获取群相册媒体列表
    getGroupAlbumMediaList(data, album_id, attach_info = "") {
      return data.bot.sendApi("get_group_album_media_list", { group_id: data.group_id, album_id, attach_info })
    }

    // 上传图片到群相册
    async uploadImageToQunAlbum(data, album_id, album_name, file) {
      return data.bot.sendApi("upload_image_to_qun_album", {
        group_id: data.group_id,
        album_id,
        album_name,
        file: await this.makeFile(file),
      })
    }

    // 删除群相册媒体
    delGroupAlbumMedia(data, album_id, lloc) {
      return data.bot.sendApi("del_group_album_media", { group_id: data.group_id, album_id, lloc })
    }

    // 点赞群相册媒体
    setGroupAlbumMediaLike(data, album_id, batch_id, lloc) {
      return data.bot.sendApi("set_group_album_media_like", { group_id: data.group_id, album_id, batch_id, lloc })
    }

    // 取消点赞群相册媒体
    cancelGroupAlbumMediaLike(data, album_id, batch_id, lloc) {
      return data.bot.sendApi("cancel_group_album_media_like", { group_id: data.group_id, album_id, batch_id, lloc })
    }

    // 发表群相册评论
    doGroupAlbumComment(data, album_id, lloc, content) {
      return data.bot.sendApi("do_group_album_comment", { group_id: data.group_id, album_id, lloc, content })
    }

    // 标记消息已读
    markMsgAsRead(data, params) {
      return data.bot.sendApi("mark_msg_as_read", params)
    }

    pickFriend(data, user_id) {
      const i = { ...data.bot.fl.get(user_id), ...data, user_id }
      return {
        ...i,
        sendMsg: this.sendFriendMsg.bind(this, i),
        getMsg: this.getMsg.bind(this, i),
        recallMsg: this.recallMsg.bind(this, i),
        getForwardMsg: this.getForwardMsg.bind(this, i),
        sendForwardMsg: this.sendFriendForwardMsg.bind(this, i),
        sendFile: this.sendFriendFile.bind(this, i),
        getFileUrl: this.getPrivateFileUrl.bind(this, i),
        getInfo: this.getFriendInfo.bind(this, i),
        getAvatarUrl() {
          return this.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
        },
        getChatHistory: this.getFriendMsgHistory.bind(this, i),
        thumbUp: (times = 10) => this.sendLike(i, times),
        delete: this.deleteFriend.bind(this, i),
        poke: () => this.sendPoke(i, null, user_id),
        setRemark: remark => this.setFriendRemark(i, remark),
        markRead: this.markPrivateRead.bind(this, i),
        forwardSingleMsg: message_id => this.forwardFriendSingleMsg(i, user_id, message_id),
        setInputStatus: params => this.setInputStatus(i, params),
        sendArkShare: params => this.sendArkShare(i, params),
      }
    }

    pickMember(data, group_id, user_id) {
      const i = {
        ...data.bot.gml.get(group_id)?.get(user_id),
        ...data,
        group_id,
        user_id,
      }
      return {
        ...this.pickFriend(i, user_id),
        ...i,
        getInfo: this.getMemberInfo.bind(this, i),
        getAvatarUrl() {
          return this.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
        },
        poke: () => this.sendPoke(i, group_id, user_id),
        mute: this.setGroupBan.bind(this, i, user_id),
        kick: this.setGroupKick.bind(this, i, user_id),
        get is_friend() {
          return data.bot.fl.has(user_id)
        },
        get is_owner() {
          return this.role === "owner"
        },
        get is_admin() {
          return this.role === "admin" || this.is_owner
        },
      }
    }

    pickGroup(data, group_id) {
      const i = { ...data.bot.gl.get(group_id), ...data, group_id }
      return {
        ...i,
        sendMsg: this.sendGroupMsg.bind(this, i),
        getMsg: this.getMsg.bind(this, i),
        recallMsg: this.recallMsg.bind(this, i),
        getForwardMsg: this.getForwardMsg.bind(this, i),
        sendForwardMsg: this.sendGroupForwardMsg.bind(this, i),
        sendFile: (file, name) => this.sendGroupFile(i, file, undefined, name),
        getFileUrl: this.getGroupFileUrl.bind(this, i),
        getInfo: this.getGroupInfo.bind(this, i),
        getAvatarUrl() {
          return this.avatar || `https://p.qlogo.cn/gh/${group_id}/${group_id}/0`
        },
        getChatHistory: this.getGroupMsgHistory.bind(this, i),
        getHonorInfo: this.getGroupHonorInfo.bind(this, i),
        getEssence: this.getEssenceMsg.bind(this, i),
        getMemberArray: this.getMemberArray.bind(this, i),
        getMemberList: this.getMemberList.bind(this, i),
        getMemberMap: this.getMemberMap.bind(this, i),
        pickMember: this.pickMember.bind(this, i, group_id),
        pokeMember: user_id => this.sendPoke(i, group_id, user_id),
        setName: this.setGroupName.bind(this, i),
        setAvatar: this.setGroupAvatar.bind(this, i),
        setAdmin: this.setGroupAdmin.bind(this, i),
        setCard: this.setGroupCard.bind(this, i),
        setTitle: this.setGroupTitle.bind(this, i),
        setRemark: remark => this.setGroupRemark(i, remark),
        sign: this.sendGroupSign.bind(this, i),
        muteMember: this.setGroupBan.bind(this, i),
        muteAll: this.setGroupWholeKick.bind(this, i),
        kickMember: this.setGroupKick.bind(this, i),
        quit: this.setGroupLeave.bind(this, i),
        markRead: this.markGroupRead.bind(this, i),
        sendNotice: (content, image) => this.sendGroupNotice(i, content, image),
        getNotice: this.getGroupNotice.bind(this, i),
        delNotice: notice_id => this.delGroupNotice(i, notice_id),
        getAtAllRemain: this.getGroupAtAllRemain.bind(this, i),
        getShutList: this.getGroupShutList.bind(this, i),
        setAddOption: option => this.setGroupAddOption(i, option),
        setTodo: params => this.setGroupTodo(i, params),
        getInfoEx: this.getGroupInfoEx.bind(this, i),
        getDetailInfo: this.getGroupDetailInfo.bind(this, i),
        getIgnoredNotifies: this.getGroupIgnoredNotifies.bind(this, i),
        kickMembers: (user_ids, reject_add_request) => this.setGroupKickMembers(i, user_ids, reject_add_request),
        deleteFolder: folder_id => this.deleteGroupFolder(i, folder_id),
        forwardSingleMsg: message_id => this.forwardGroupSingleMsg(i, group_id, message_id),
        setSign: params => this.setGroupSign(i, params),
        getSignedList: this.getGroupSignedList.bind(this, i),
        completeTodo: params => this.completeGroupTodo(i, params),
        cancelTodo: params => this.cancelGroupTodo(i, params),
        setSearch: params => this.setGroupSearch(i, params),
        setRobotAddOption: params => this.setGroupRobotAddOption(i, params),
        sendArkShare: params => this.sendGroupArkShare(i, params),
        fs: this.getGroupFs(i),

        getQunAlbumList: this.getQunAlbumList.bind(this, i),
        getGroupAlbumMediaList: this.getGroupAlbumMediaList.bind(this, i),
        uploadImageToQunAlbum: this.uploadImageToQunAlbum.bind(this, i),
        delGroupAlbumMedia: this.delGroupAlbumMedia.bind(this, i),
        setGroupAlbumMediaLike: this.setGroupAlbumMediaLike.bind(this, i),
        cancelGroupAlbumMediaLike: this.cancelGroupAlbumMediaLike.bind(this, i),
        doGroupAlbumComment: this.doGroupAlbumComment.bind(this, i),

        get is_owner() {
          return data.bot.gml.get(group_id)?.get(data.self_id)?.role === "owner"
        },
        get is_admin() {
          return data.bot.gml.get(group_id)?.get(data.self_id)?.role === "admin" || this.is_owner
        },
      }
    }

    async connect(data, ws) {
      Bot[data.self_id] = {
        adapter: this,
        ws: ws,
        sendApi: this.sendApi.bind(this, data, ws),
        stat: {
          start_time: data.time,
          stat: {},
          get lost_pkt_cnt() {
            return this.stat.packet_lost
          },
          get lost_times() {
            return this.stat.lost_times
          },
          get recv_msg_cnt() {
            return this.stat.message_received
          },
          get recv_pkt_cnt() {
            return this.stat.packet_received
          },
          get sent_msg_cnt() {
            return this.stat.message_sent
          },
          get sent_pkt_cnt() {
            return this.stat.packet_sent
          },
        },
        model: "Yunzai",

        info: {},
        get uin() {
          return this.info.user_id
        },
        get nickname() {
          return this.info.nickname
        },
        get avatar() {
          return `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`
        },

        setProfile: this.setProfile.bind(this, data),
        setNickname: nickname => this.setProfile(data, { nickname }),
        setAvatar: this.setAvatar.bind(this, data),

        pickFriend: this.pickFriend.bind(this, data),
        get pickUser() {
          return this.pickFriend
        },
        getFriendArray: this.getFriendArray.bind(this, data),
        getFriendList: this.getFriendList.bind(this, data),
        getFriendMap: this.getFriendMap.bind(this, data),
        fl: new Map(),

        pickMember: this.pickMember.bind(this, data),
        pickGroup: this.pickGroup.bind(this, data),
        getGroupArray: this.getGroupArray.bind(this, data),
        getGroupList: this.getGroupList.bind(this, data),
        getGroupMap: this.getGroupMap.bind(this, data),
        getGroupMemberMap: this.getGroupMemberMap.bind(this, data),
        gl: new Map(),
        gml: new Map(),

        request_list: [],
        getSystemMsg() {
          return this.request_list
        },
        setFriendAddRequest: this.setFriendAddRequest.bind(this, data),
        setGroupAddRequest: this.setGroupAddRequest.bind(this, data),

        getDoubtFriendsAddRequest: count => this.getDoubtFriendsAddRequest(data, count),
        setDoubtFriendsAddRequest: params => this.setDoubtFriendsAddRequest(data, params),

        setEssenceMessage: this.setEssenceMsg.bind(this, data),
        removeEssenceMessage: this.deleteEssenceMsg.bind(this, data),

        sendPoke: (group_id, user_id) => this.sendPoke(data, group_id, user_id),
        setMsgEmojiLike: (message_id, emoji_id, set) => this.setMsgEmojiLike(data, message_id, emoji_id, set),

        getGroupAtAllRemain: group_id => this.getGroupAtAllRemain({ ...data, group_id }),
        getRecentContact: count => this.getRecentContact(data, count),
        getGroupSystemMsg: count => this.getGroupSystemMsg(data, count),
        getGroupShutList: group_id => this.getGroupShutList({ ...data, group_id }),
        getGroupDetailInfo: group_id => this.getGroupDetailInfo({ ...data, group_id }),
        setGroupKickMembers: (group_id, user_ids, reject_add_request) => this.setGroupKickMembers({ ...data, group_id }, user_ids, reject_add_request),

        setOnlineStatus: status => this.setOnlineStatus(data, status),
        setDiyOnlineStatus: (face_id, face_type, wording) => this.setDiyOnlineStatus(data, face_id, face_type, wording),
        setSelfLongnick: longNick => this.setSelfLongnick(data, longNick),

        getProfileLike: (start, count, user_id) => this.getProfileLike(data, start, count, user_id),
        getPrivateFileUrl: (user_id, file_id) => this.getPrivateFileUrl({ ...data, user_id }, file_id),
        getFriendsWithCategory: this.getFriendsWithCategory.bind(this, data),
        ocrImage: image => this.ocrImage(data, image),

        forwardFriendSingleMsg: (user_id, message_id) => this.forwardFriendSingleMsg(data, user_id, message_id),
        forwardGroupSingleMsg: (group_id, message_id) => this.forwardGroupSingleMsg(data, group_id, message_id),

        createCollection: params => this.createCollection(data, params),
        getCollectionList: params => this.getCollectionList(data, params),

        setInputStatus: params => this.setInputStatus(data, params),

        fetchEmojiLike: params => this.fetchEmojiLike(data, params),
        getEmojiLikes: params => this.getEmojiLikes(data, params),

        sendGroupArkShare: params => this.sendGroupArkShare(data, params),
        sendArkShare: params => this.sendArkShare(data, params),
        fetchPttText: params => this.fetchPttText(data, params),
        getMiniAppArk: params => this.getMiniAppArk(data, params),

        markMsgAsRead: params => this.markMsgAsRead(data, params),
        sendQzoneMsg: (content, images, ugc_right, target_uins) => this.sendQzoneMsg(data, content, images, ugc_right, target_uins),
        deleteQzoneMsg: tid => this.deleteQzoneMsg(data, tid),

        cookies: {},
        getCookies(domain) {
          return this.cookies[domain]
        },
        getCsrfToken() {
          return this.bkn
        },
      }
      data.bot = Bot[data.self_id]

      if (!Bot.uin.includes(data.self_id)) Bot.uin.push(data.self_id)

      data.bot.sendApi("_set_model_show", { model: data.bot.model, model_show: data.bot.model }).catch(() => {})

      data.bot.info = (await data.bot.sendApi("get_login_info").catch(i => i.error)).data
      data.bot.clients = (await data.bot.sendApi("get_online_clients").catch(i => i.error)).clients
      data.bot.version = {
        ...(await data.bot.sendApi("get_version_info").catch(i => i.error)).data,
        id: this.id,
        name: this.name,
        get version() {
          return this.app_full_name || `${this.app_name} v${this.app_version}`
        },
      }

      data.bot.bkn = (await data.bot.sendApi("get_csrf_token").catch(i => i.error)).token

      data.bot
        .sendApi("get_cookies", { domain: "qun.qq.com" })
        .then(res => {
          const cookies = res?.data?.cookies ?? res?.cookies
          if (cookies) {
            data.bot.cookies["qun.qq.com"] = cookies
            const domains = ["aq", "connect", "docs", "game", "gamecenter", "haoma", "id", "kg", "mail", "mma", "office", "openmobile", "qqweb", "qzone", "ti", "v", "vip", "y"]
            for (const i of domains) {
              const domain = `${i}.qq.com`
              data.bot
                .sendApi("get_cookies", { domain })
                .then(r => {
                  const ck = r?.data?.cookies ?? r?.cookies
                  if (ck) data.bot.cookies[domain] = ck
                })
                .catch(() => {})
            }
          }
        })
        .catch(() => {})

      data.bot.getFriendMap()
      data.bot.getGroupMemberMap()

      Bot.makeLog("mark", `${this.name}(${this.id}) ${data.bot.version.version} 已连接`, data.self_id)
      Bot.em(`connect.${data.self_id}`, data)
    }

    makeMessage(data) {
      data.message = this.parseMsg(data.message)
      return this.enrichMessage(data).then(() => {
        switch (data.message_type) {
          case "private": {
            const name = data.sender?.card || data.sender?.nickname || data.bot.fl.get(data.user_id)?.nickname
            Bot.makeLog("info", `好友消息：${name ? `[${name}] ` : ""}${data.raw_message}`, `${data.self_id} <= ${data.user_id}`, true)
            break
          }
          case "group": {
            const group_name = data.group_name || data.bot.gl.get(data.group_id)?.group_name
            let user_name = data.sender?.card || data.sender?.nickname
            if (!user_name) {
              const user = data.bot.gml.get(data.group_id)?.get(data.user_id) || data.bot.fl.get(data.user_id)
              if (user) user_name = user?.card || user?.nickname
            }
            Bot.makeLog("info", `群消息：${user_name ? `[${group_name ? `${group_name}, ` : ""}${user_name}] ` : ""}${data.raw_message}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
            break
          }
          default:
            Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, data.self_id)
        }

        Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
      })
    }

    async enrichMessage(data) {
      const reply = data.message.find(i => i.type === "reply")
      if (reply?.id) {
        try {
          const src = await data.bot.sendApi("get_msg", { message_id: reply.id })
          const srcMsg = src?.data?.message ?? src?.message
          if (srcMsg) {
            const parsed = this.parseMsg(srcMsg)
            const images = parsed
              .filter(i => i.type === "image")
              .map(i => i.url || i.file_url || i.file)
              .filter(Boolean)
            reply.source_message = parsed
            if (images.length) {
              reply.images = images
              for (const url of images) data.message.push({ type: "image", file: url, url, sub_type: "reply" })
            }
          }
        } catch (err) {
          Bot.makeLog("debug", ["解析引用消息失败", err], data.self_id)
        }
      }

      for (const seg of data.message) {
        if (seg.type !== "file") continue

        if (seg.url) continue
        const file_id = seg.file_id || seg.file || seg.id
        if (!file_id) continue

        const info = await this.resolveFileUrl(data, file_id, seg.busid).catch(err => {
          Bot.makeLog("debug", [`获取文件下载链接失败 ${file_id}`, err], data.self_id)
          return null
        })
        if (!info) continue

        if (info.url) seg.url = info.url
        if (info.file && !seg.path) seg.path = info.file
        if (info.file_name && !seg.name) seg.name = info.file_name
        if (info.file_size && !seg.size) seg.size = info.file_size
      }
    }

    async resolveFileUrl(data, file_id, busid) {
      const pickUrl = res => res?.data?.url ?? res?.url
      if (data.message_type === "group" && data.group_id) {
        const params = { group_id: data.group_id, file_id }
        if (busid !== undefined) params.busid = busid
        const res = await data.bot.sendApi("get_group_file_url", params)
        if (pickUrl(res)) return res.data || res
      } else if (data.message_type === "private" && data.user_id) {
        const res = await data.bot.sendApi("get_private_file_url", {
          user_id: data.user_id,
          file_id,
        })
        if (pickUrl(res)) return res.data || res
      }
      const res = await data.bot.sendApi("get_file", { file_id })
      return res?.data ?? res ?? null
    }

    async makeNotice(data) {
      switch (data.notice_type) {
        case "friend_recall":
          Bot.makeLog("info", `好友消息撤回：${data.message_id}`, `${data.self_id} <= ${data.user_id}`, true)
          break
        case "group_recall":
          Bot.makeLog("info", `群消息撤回：${data.operator_id} => ${data.user_id} ${data.message_id}`, `${data.self_id} <= ${data.group_id}`, true)
          break
        case "group_increase": {
          Bot.makeLog("info", `群成员增加：${data.operator_id} => ${data.user_id} ${data.sub_type}`, `${data.self_id} <= ${data.group_id}`, true)
          const group = data.bot.pickGroup(data.group_id)
          group.getInfo().catch(() => {})
          if (data.user_id === data.self_id && cfg.bot.cache_group_member) group.getMemberMap().catch(() => {})
          else
            group
              .pickMember(data.user_id)
              .getInfo()
              .catch(() => {})
          break
        }
        case "group_decrease":
          Bot.makeLog("info", `群成员减少：${data.operator_id} => ${data.user_id} ${data.sub_type}`, `${data.self_id} <= ${data.group_id}`, true)
          if (data.user_id === data.self_id) {
            data.bot.gl.delete(data.group_id)
            data.bot.gml.delete(data.group_id)
          } else {
            const cached = data.bot.gml.get(data.group_id)?.get(data.user_id)
            if (cached) {
              data.sender ||= { user_id: data.user_id }
              data.sender.nickname ||= cached.nickname
              data.sender.card ||= cached.card
              Object.defineProperty(data, "member", {
                value: { ...cached, group_id: data.group_id, user_id: data.user_id },
                configurable: true,
              })
            }
            data.bot.gml.get(data.group_id)?.delete(data.user_id)
            data.bot
              .pickGroup(data.group_id)
              .getInfo()
              .catch(() => {})
          }
          break
        case "group_admin":
          Bot.makeLog("info", `群管理员变动：${data.sub_type}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
          data.set = data.sub_type === "set"
          data.bot
            .pickMember(data.group_id, data.user_id)
            .getInfo()
            .catch(() => {})
          break
        case "group_upload": {
          Bot.makeLog("info", `群文件上传：${Bot.String(data.file)}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
          const file_id = data.file.id || data.file.file_id || data.file.file
          const seg = { ...data.file, type: "file" }
          const fileName = (data.file.name || "").toLowerCase()
          if (fileName.endsWith(".json") && file_id && !seg.url) {
            const info = await this.resolveFileUrl({ ...data, message_type: "group" }, file_id, data.file.busid).catch(err => {
              Bot.makeLog("debug", [`获取群文件下载链接失败 ${file_id}`, err], data.self_id)
              return null
            })
            if (info) {
              if (info.url) seg.url = info.url
              if (info.file && !seg.path) seg.path = info.file
              if (info.file_name && !seg.name) seg.name = info.file_name
              if (info.file_size && !seg.size) seg.size = info.file_size
            }
          }
          Bot.em("message.group.normal", {
            ...data,
            post_type: "message",
            message_type: "group",
            sub_type: "normal",
            message: [seg],
            raw_message: `[文件：${data.file.name}]`,
          })
          break
        }
        case "group_ban":
          Bot.makeLog("info", `群禁言：${data.operator_id} => ${data.user_id} ${data.sub_type} ${data.duration}秒`, `${data.self_id} <= ${data.group_id}`, true)
          if (data.user_id !== 0) {
            data.bot
              .pickMember(data.group_id, data.user_id)
              .getInfo(true)
              .catch(() => {})
          }
          break
        case "group_msg_emoji_like":
          Bot.makeLog("info", [`群消息回应：${data.message_id}`, data.likes], `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
          break
        case "friend_add":
          Bot.makeLog("info", "好友添加", `${data.self_id} <= ${data.user_id}`, true)
          this.getFriendMap(data)
            .then(() => {
              data.bot
                .pickFriend(data.user_id)
                .getInfo()
                .catch(() => {})
            })
            .catch(() => {})
          break
        case "notify":
          if (data.group_id) data.notice_type = "group"
          else data.notice_type = "friend"
          data.user_id ??= data.operator_id || data.target_id
          switch (data.sub_type) {
            case "poke":
              data.operator_id = data.user_id
              Bot.makeLog("info", `${data.group_id ? "群" : "好友"}戳一戳：${data.operator_id} => ${data.target_id}`, data.group_id ? `${data.self_id} <= ${data.group_id}` : data.self_id, true)
              break
            case "poke_recall":
              data.operator_id = data.user_id
              Bot.makeLog("info", `${data.group_id ? "群" : "好友"}戳一戳撤回：${data.operator_id} => ${data.target_id}`, data.group_id ? `${data.self_id} <= ${data.group_id}` : data.self_id, true)
              break
            case "honor":
              Bot.makeLog("info", `群荣誉：${data.honor_type}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
              data.bot
                .pickMember(data.group_id, data.user_id)
                .getInfo()
                .catch(() => {})
              break
            case "title":
              Bot.makeLog("info", `群头衔：${data.title}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
              data.bot
                .pickMember(data.group_id, data.user_id)
                .getInfo()
                .catch(() => {})
              break
            case "group_name":
              Bot.makeLog("info", `群名更改：${data.name_new}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
              data.bot
                .pickGroup(data.group_id)
                .getInfo(true)
                .catch(() => {})
              break
            case "input_status":
              data.post_type = "internal"
              data.notice_type = "input"
              data.end ??= data.event_type !== 1
              data.message ||= data.status_text || `对方${data.end ? "结束" : "正在"}输入...`
              Bot.makeLog("info", data.message, `${data.self_id} <= ${data.user_id}`, true)
              break
            case "profile_like":
              Bot.makeLog("info", `资料卡点赞：${data.times}次`, `${data.self_id} <= ${data.operator_id}`, true)
              break
            default:
              Bot.makeLog("warn", `未知通知：${logger.magenta(data.raw)}`, data.self_id)
          }
          break
        case "group_card":
          Bot.makeLog("info", `群名片更新：${data.card_old} => ${data.card_new}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
          data.bot
            .pickMember(data.group_id, data.user_id)
            .getInfo()
            .catch(() => {})
          break
        case "essence":
          data.notice_type = "group_essence"
          Bot.makeLog("info", `群精华消息：${data.operator_id} => ${data.sender_id} ${data.sub_type} ${data.message_id}`, `${data.self_id} <= ${data.group_id}`, true)
          break
        case "offline_file":
          Bot.makeLog("info", `离线文件：${Bot.String(data.file)}`, `${data.self_id} <= ${data.user_id}`, true)
          Bot.em("message.private.friend", {
            ...data,
            post_type: "message",
            message_type: "private",
            sub_type: "friend",
            message: [{ ...data.file, type: "file" }],
            raw_message: `[文件：${data.file.name}]`,
          })
          break
        case "client_status":
          Bot.makeLog("info", `客户端${data.online ? "上线" : "下线"}：${Bot.String(data.client)}`, data.self_id)
          data.clients = (await data.bot.sendApi("get_online_clients").catch(() => ({}))).clients || []
          data.bot.clients = data.clients
          break
        case "bot_offline":
          data.post_type = "system"
          data.notice_type = "offline"
          Bot.makeLog("info", `账号下线：${data.message}`, data.self_id)
          Bot.sendMasterMsg?.(`[${data.self_id}] 账号下线：${data.message}`)
          break
        default:
          Bot.makeLog("warn", `未知通知：${logger.magenta(data.raw)}`, data.self_id)
      }

      let notice = (data.notice_type || "").split("_")
      data.notice_type = notice.shift()
      notice = notice.join("_")
      if (notice) data.sub_type = notice

      Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
    }

    makeRequest(data) {
      switch (data.request_type) {
        case "friend":
          Bot.makeLog("info", `加好友请求：${data.comment}(${data.flag})`, `${data.self_id} <= ${data.user_id}`, true)
          data.sub_type = "add"
          data.approve = function (approve, remark) {
            return this.bot.setFriendAddRequest(this.flag, approve, remark)
          }
          break
        case "group":
          Bot.makeLog("info", `加群请求：${data.sub_type} ${data.comment}(${data.flag})`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
          data.approve = function (approve, reason) {
            return this.bot.setGroupAddRequest(this.flag, approve, reason, this.sub_type)
          }
          break
        default:
          Bot.makeLog("warn", `未知请求：${logger.magenta(data.raw)}`, data.self_id)
      }

      data.bot.request_list.push(data)
      Bot.em(`${data.post_type}.${data.request_type}.${data.sub_type}`, data)
    }

    heartbeat(data) {
      if (data.status) Object.assign(data.bot.stat, data.status)
    }

    makeMeta(data, ws) {
      switch (data.meta_event_type) {
        case "heartbeat":
          this.heartbeat(data)
          break
        case "lifecycle":
          this.connect(data, ws)
          break
        default:
          Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, data.self_id)
      }
    }

    isDuplicate(data) {
      if (data.post_type !== "message" && data.post_type !== "message_sent") return false
      const id = data.message_id
      if (id === undefined || id === null) return false
      const key = `${data.self_id}:${data.post_type}:${data.message_type || ""}:${id}`
      const now = Date.now()
      if (this.seen.has(key)) return true
      if (this.seen.size > 64) for (const [k, t] of this.seen) if (now - t > this.seenTimeout) this.seen.delete(k)
      this.seen.set(key, now)
      return false
    }

    message(data, ws) {
      try {
        data = { ...JSON.parse(data), raw: Bot.String(data) }
      } catch (err) {
        return Bot.makeLog("error", ["解码数据失败", data, err])
      }

      if (data.post_type) {
        if (data.meta_event_type !== "lifecycle" && !Bot.uin.includes(data.self_id)) {
          Bot.makeLog("warn", `找不到对应Bot，忽略消息：${logger.magenta(data.raw)}`, data.self_id)
          return false
        }
        data.bot = Bot[data.self_id]

        if (this.isDuplicate(data)) {
          Bot.makeLog("debug", `重复上报，忽略消息：${data.message_id}`, data.self_id)
          return false
        }

        switch (data.post_type) {
          case "meta_event":
            return this.makeMeta(data, ws)
          case "message":
            return this.makeMessage(data)
          case "notice":
            return this.makeNotice(data)
          case "request":
            return this.makeRequest(data)
          case "message_sent":
            data.post_type = "message"
            return this.makeMessage(data)
        }
      } else if (data.echo) {
        const cache = this.echo.get(data.echo)
        if (cache) return cache.resolve(data)
      }
      Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, data.self_id)
    }

    load() {
      if (!Array.isArray(Bot.wsf[this.path])) Bot.wsf[this.path] = []
      Bot.wsf[this.path].push((ws, ...args) => ws.on("message", data => this.message(data, ws, ...args)))
    }
  })(),
)
