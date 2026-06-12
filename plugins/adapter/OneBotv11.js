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

    async getMsg(data, message_id) {
      const msg = (await data.bot.sendApi("get_msg", { message_id })).data
      if (msg?.message) msg.message = this.parseMsg(msg.message)
      return msg
    }

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

    async sendFriendForwardMsg(data, msg) {
      Bot.makeLog("info", `发送好友转发消息：${this.makeLog(msg)}`, `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("send_private_forward_msg", {
        user_id: data.user_id,
        messages: await this.makeForwardMsg(msg, data),
      })
    }

    async sendGroupForwardMsg(data, msg) {
      Bot.makeLog("info", `发送群转发消息：${this.makeLog(msg)}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("send_group_forward_msg", {
        group_id: data.group_id,
        messages: await this.makeForwardMsg(msg, data),
      })
    }

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
    async getFriendInfo(data) {
      const info = (await data.bot.sendApi("get_stranger_info", { user_id: data.user_id })).data
      data.bot.fl.set(data.user_id, info)
      return info
    }

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
    async getGroupInfo(data) {
      const info = (await data.bot.sendApi("get_group_info", { group_id: data.group_id })).data
      data.bot.gl.set(data.group_id, info)
      return info
    }

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
    async getMemberInfo(data) {
      const info = (
        await data.bot.sendApi("get_group_member_info", {
          group_id: data.group_id,
          user_id: data.user_id,
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

    setProfile(data, profile) {
      Bot.makeLog("info", `设置资料：${Bot.String(profile)}`, data.self_id)
      return data.bot.sendApi("set_qq_profile", profile)
    }

    async setAvatar(data, file) {
      Bot.makeLog("info", `设置头像：${file}`, data.self_id)
      return data.bot.sendApi("set_qq_avatar", { file: await this.makeFile(file) })
    }

    sendLike(data, user_id, times) {
      Bot.makeLog("info", `点赞：${times}次`, `${data.self_id} => ${user_id}`, true)
      return data.bot.sendApi("send_like", { user_id, times })
    }

    setGroupName(data, group_name) {
      Bot.makeLog("info", `设置群名：${group_name}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_name", { group_id: data.group_id, group_name })
    }

    async setGroupAvatar(data, file) {
      Bot.makeLog("info", `设置群头像：${file}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_portrait", {
        group_id: data.group_id,
        file: await this.makeFile(file),
      })
    }

    setGroupAdmin(data, user_id, enable) {
      Bot.makeLog("info", `${enable ? "设置" : "取消"}群管理员：${user_id}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_admin", { group_id: data.group_id, user_id, enable })
    }

    setGroupCard(data, user_id, card) {
      Bot.makeLog("info", `设置群名片：${card}`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_card", { group_id: data.group_id, user_id, card })
    }

    setGroupTitle(data, user_id, special_title, duration) {
      Bot.makeLog("info", `设置群头衔：${special_title} ${duration}`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_special_title", {
        group_id: data.group_id,
        user_id,
        special_title,
        duration,
      })
    }

    sendGroupSign(data) {
      Bot.makeLog("info", "群打卡", `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("send_group_sign", { group_id: data.group_id })
    }

    setGroupBan(data, user_id, duration) {
      Bot.makeLog("info", `禁言群成员：${duration}秒`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_ban", { group_id: data.group_id, user_id, duration })
    }

    setGroupWholeKick(data, enable) {
      Bot.makeLog("info", `${enable ? "开启" : "关闭"}全员禁言`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_whole_ban", { group_id: data.group_id, enable })
    }

    setGroupKick(data, user_id, reject_add_request) {
      Bot.makeLog("info", `踢出群成员${reject_add_request ? "拒绝再次加群" : ""}`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
      return data.bot.sendApi("set_group_kick", {
        group_id: data.group_id,
        user_id,
        reject_add_request,
      })
    }

    setGroupLeave(data, is_dismiss) {
      Bot.makeLog("info", is_dismiss ? "解散" : "退群", `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_leave", { group_id: data.group_id, is_dismiss })
    }

    setFriendRemark(data, user_id, remark) {
      Bot.makeLog("info", `设置好友备注：${remark}`, `${data.self_id} => ${user_id}`, true)
      return data.bot.sendApi("set_friend_remark", { user_id, remark })
    }

    setGroupRemark(data, group_id, remark) {
      Bot.makeLog("info", `设置群备注：${remark}`, `${data.self_id} => ${group_id}`, true)
      return data.bot.sendApi("set_group_remark", { group_id, remark })
    }

    async sendFriendFile(data, file, name = path.basename(file)) {
      Bot.makeLog("info", `发送好友文件：${name}(${file})`, `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("upload_private_file", {
        user_id: data.user_id,
        file: (await this.makeFile(file, { file: true })).replace("file://", ""),
        name,
      })
    }

    async sendGroupFile(data, file, folder, name = path.basename(file)) {
      Bot.makeLog("info", `发送群文件：${folder || ""}/${name}(${file})`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("upload_group_file", {
        group_id: data.group_id,
        folder,
        file: (await this.makeFile(file, { file: true })).replace("file://", ""),
        name,
      })
    }

    deleteGroupFile(data, file_id, busid) {
      Bot.makeLog("info", `删除群文件：${file_id}(${busid})`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("delete_group_file", { group_id: data.group_id, file_id, busid })
    }

    createGroupFileFolder(data, name) {
      Bot.makeLog("info", `创建群文件夹：${name}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("create_group_file_folder", { group_id: data.group_id, name })
    }

    getGroupFileSystemInfo(data) {
      return data.bot.sendApi("get_group_file_system_info", { group_id: data.group_id })
    }

    getGroupFiles(data, folder_id) {
      if (folder_id)
        return data.bot.sendApi("get_group_files_by_folder", {
          group_id: data.group_id,
          folder_id,
        })
      return data.bot.sendApi("get_group_root_files", { group_id: data.group_id })
    }

    getGroupFileUrl(data, file_id, busid) {
      return data.bot.sendApi("get_group_file_url", { group_id: data.group_id, file_id, busid })
    }

    getGroupFs(data) {
      return {
        upload: this.sendGroupFile.bind(this, data),
        rm: this.deleteGroupFile.bind(this, data),
        mkdir: this.createGroupFileFolder.bind(this, data),
        df: this.getGroupFileSystemInfo.bind(this, data),
        ls: this.getGroupFiles.bind(this, data),
        download: this.getGroupFileUrl.bind(this, data),
      }
    }

    deleteFriend(data) {
      Bot.makeLog("info", "删除好友", `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("delete_friend", { user_id: data.user_id }).finally(this.getFriendMap.bind(this, data))
    }

    setFriendAddRequest(data, flag, approve, remark) {
      return data.bot.sendApi("set_friend_add_request", { flag, approve, remark })
    }

    setGroupAddRequest(data, flag, approve, reason, sub_type = "add") {
      return data.bot.sendApi("set_group_add_request", { flag, sub_type, approve, reason })
    }

    getGroupHonorInfo(data) {
      return data.bot.sendApi("get_group_honor_info", { group_id: data.group_id })
    }

    getEssenceMsg(data) {
      return data.bot.sendApi("get_essence_msg_list", { group_id: data.group_id })
    }
    setEssenceMsg(data, message_id) {
      return data.bot.sendApi("set_essence_msg", { message_id })
    }
    deleteEssenceMsg(data, message_id) {
      return data.bot.sendApi("delete_essence_msg", { message_id })
    }

    sendPoke(data, group_id, user_id) {
      const target_id = user_id ?? data.user_id
      Bot.makeLog("info", `发送戳一戳：${target_id}`, group_id ? `${data.self_id} => ${group_id}` : `${data.self_id} => ${target_id}`, true)
      if (group_id) return data.bot.sendApi("group_poke", { group_id, user_id: target_id })
      return data.bot.sendApi("friend_poke", { user_id: target_id })
    }

    setMsgEmojiLike(data, message_id, emoji_id, set = true) {
      return data.bot.sendApi("set_msg_emoji_like", { message_id, emoji_id, set })
    }

    sendGroupNotice(data, content, image) {
      return data.bot.sendApi("_send_group_notice", { group_id: data.group_id, content, image })
    }
    getGroupNotice(data) {
      return data.bot.sendApi("_get_group_notice", { group_id: data.group_id })
    }
    delGroupNotice(data, notice_id) {
      return data.bot.sendApi("_del_group_notice", { group_id: data.group_id, notice_id })
    }

    markGroupRead(data) {
      return data.bot.sendApi("mark_group_msg_as_read", { group_id: data.group_id })
    }
    markPrivateRead(data) {
      return data.bot.sendApi("mark_private_msg_as_read", { user_id: data.user_id })
    }

    getRecentContact(data, count = 10) {
      return data.bot.sendApi("get_recent_contact", { count })
    }

    getAiCharacters(data, group_id, chat_type) {
      return data.bot.sendApi("get_ai_characters", { group_id, chat_type })
    }
    sendGroupAiRecord(data, group_id, character, text) {
      return data.bot.sendApi("send_group_ai_record", { group_id, character, text })
    }

    clickInlineKeyboardButton(data, params) {
      return data.bot.sendApi("click_inline_keyboard_button", params)
    }

    getGroupAtAllRemain(data) {
      return data.bot.sendApi("get_group_at_all_remain", { group_id: data.group_id })
    }

    getGroupSystemMsg(data, count = 50) {
      return data.bot.sendApi("get_group_system_msg", { count })
    }

    getGroupShutList(data) {
      return data.bot.sendApi("get_group_shut_list", { group_id: data.group_id })
    }

    setGroupAddOption(data, option) {
      return data.bot.sendApi("set_group_add_option", { group_id: data.group_id, ...option })
    }

    setGroupTodo(data, params) {
      return data.bot.sendApi("set_group_todo", { group_id: data.group_id, ...params })
    }

    getGroupInfoEx(data) {
      return data.bot.sendApi("get_group_info_ex", { group_id: data.group_id })
    }

    getGroupIgnoredNotifies(data) {
      return data.bot.sendApi("get_group_ignored_notifies", { group_id: data.group_id })
    }

    markAllAsRead(data) {
      return data.bot.sendApi("_mark_all_as_read", {})
    }

    setOnlineStatus(data, status) {
      return data.bot.sendApi("set_online_status", status)
    }

    setDiyOnlineStatus(data, face_id, face_type = 1, wording = "") {
      return data.bot.sendApi("set_diy_online_status", { face_id, face_type, wording })
    }

    setSelfLongnick(data, longnick) {
      Bot.makeLog("info", `设置个性签名：${longnick}`, data.self_id)
      return data.bot.sendApi("set_self_longnick", { longnick })
    }

    getProfileLike(data, start_time = 0) {
      return data.bot.sendApi("get_profile_like", { start_time })
    }

    getImage(data, file) {
      return data.bot.sendApi("get_image", { file })
    }

    getRecord(data, file, out_format = "mp3") {
      return data.bot.sendApi("get_record", { file, out_format })
    }

    canSendImage(data) {
      return data.bot.sendApi("can_send_image", {})
    }

    canSendRecord(data) {
      return data.bot.sendApi("can_send_record", {})
    }

    downloadFile(data, url, thread_count = 3, headers) {
      return data.bot.sendApi("download_file", { url, thread_count, headers })
    }

    getStatus(data) {
      return data.bot.sendApi("get_status", {})
    }

    getUnidirectionalFriendList(data) {
      return data.bot.sendApi("get_unidirectional_friend_list", {})
    }

    getFriendsWithCategory(data) {
      return data.bot.sendApi("get_friends_with_category", {})
    }

    checkUrlSafely(data, url) {
      return data.bot.sendApi("check_url_safely", { url })
    }

    ocrImage(data, image) {
      return data.bot.sendApi("ocr_image", { image })
    }

    forwardFriendSingleMsg(data, user_id, message_id) {
      return data.bot.sendApi("forward_friend_single_msg", { user_id, message_id })
    }

    forwardGroupSingleMsg(data, group_id, message_id) {
      return data.bot.sendApi("forward_group_single_msg", { group_id, message_id })
    }

    getDoubtFriendsAddRequest(data) {
      return data.bot.sendApi("get_doubt_friends_add_request", {})
    }

    setDoubtFriendsAddRequest(data, params) {
      return data.bot.sendApi("set_doubt_friends_add_request", params)
    }

    getRkey(data, domain) {
      return data.bot.sendApi("get_rkey", { domain })
    }

    ncGetRkey(data) {
      return data.bot.sendApi("nc_get_rkey", {})
    }

    getClientkey(data) {
      return data.bot.sendApi("get_clientkey", {})
    }

    getCredentials(data, domain) {
      return data.bot.sendApi("get_credentials", { domain })
    }

    getRobotUinRange(data) {
      return data.bot.sendApi("get_robot_uin_range", {})
    }

    ncGetPacketStatus(data) {
      return data.bot.sendApi("nc_get_packet_status", {})
    }

    ncGetUserStatus(data, user_id) {
      return data.bot.sendApi("nc_get_user_status", { user_id })
    }

    sendPacket(data, cmd, packet) {
      return data.bot.sendApi("send_packet", { cmd, packet })
    }

    deleteGroupFolder(data, folder_id) {
      return data.bot.sendApi("delete_group_folder", { group_id: data.group_id, folder_id })
    }

    createCollection(data, params) {
      return data.bot.sendApi("create_collection", params)
    }

    getCollectionList(data, params) {
      return data.bot.sendApi("get_collection_list", params || {})
    }

    getGroupDetailInfo(data) {
      return data.bot.sendApi("get_group_detail_info", { group_id: data.group_id })
    }

    setGroupKickMembers(data, user_ids, reject_add_request) {
      return data.bot.sendApi("set_group_kick_members", {
        group_id: data.group_id,
        user_ids,
        reject_add_request,
      })
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
        getInfo: this.getFriendInfo.bind(this, i),
        getAvatarUrl() {
          return this.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
        },
        getChatHistory: this.getFriendMsgHistory.bind(this, i),
        thumbUp: (times = 1) => this.sendLike(i, user_id, times),
        delete: this.deleteFriend.bind(this, i),
        poke: () => this.sendPoke(i, null, user_id),
        setRemark: remark => this.setFriendRemark(i, user_id, remark),
        markRead: this.markPrivateRead.bind(this, i),
        forwardSingleMsg: message_id => this.forwardFriendSingleMsg(i, user_id, message_id),
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
        setRemark: remark => this.setGroupRemark(i, group_id, remark),
        sign: this.sendGroupSign.bind(this, i),
        muteMember: this.setGroupBan.bind(this, i),
        muteAll: this.setGroupWholeKick.bind(this, i),
        kickMember: this.setGroupKick.bind(this, i),
        quit: this.setGroupLeave.bind(this, i),
        markRead: this.markGroupRead.bind(this, i),
        markAllRead: this.markAllAsRead.bind(this, i),
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
        fs: this.getGroupFs(i),
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
        model: "AIGC Yunzai NapCat",

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

        setEssenceMessage: this.setEssenceMsg.bind(this, data),
        removeEssenceMessage: this.deleteEssenceMsg.bind(this, data),

        sendPoke: (group_id, user_id) => this.sendPoke(data, group_id, user_id),
        setMsgEmojiLike: (message_id, emoji_id, set) => this.setMsgEmojiLike(data, message_id, emoji_id, set),
        getRecentContact: count => this.getRecentContact(data, count),

        getGroupAtAllRemain: group_id => this.getGroupAtAllRemain({ ...data, group_id }),
        getGroupSystemMsg: count => this.getGroupSystemMsg(data, count),
        getGroupShutList: group_id => this.getGroupShutList({ ...data, group_id }),
        getGroupDetailInfo: group_id => this.getGroupDetailInfo({ ...data, group_id }),
        setGroupKickMembers: (group_id, user_ids, reject_add_request) => this.setGroupKickMembers({ ...data, group_id }, user_ids, reject_add_request),

        markAllAsRead: this.markAllAsRead.bind(this, data),
        setOnlineStatus: status => this.setOnlineStatus(data, status),
        setDiyOnlineStatus: (face_id, face_type, wording) => this.setDiyOnlineStatus(data, face_id, face_type, wording),
        setSelfLongnick: longnick => this.setSelfLongnick(data, longnick),

        getProfileLike: start_time => this.getProfileLike(data, start_time),
        getImage: file => this.getImage(data, file),
        getRecord: (file, out_format) => this.getRecord(data, file, out_format),
        canSendImage: this.canSendImage.bind(this, data),
        canSendRecord: this.canSendRecord.bind(this, data),
        downloadFile: (url, thread_count, headers) => this.downloadFile(data, url, thread_count, headers),
        getStatus: this.getStatus.bind(this, data),

        getUnidirectionalFriendList: this.getUnidirectionalFriendList.bind(this, data),
        getFriendsWithCategory: this.getFriendsWithCategory.bind(this, data),
        checkUrlSafely: url => this.checkUrlSafely(data, url),
        ocrImage: image => this.ocrImage(data, image),

        forwardFriendSingleMsg: (user_id, message_id) => this.forwardFriendSingleMsg(data, user_id, message_id),
        forwardGroupSingleMsg: (group_id, message_id) => this.forwardGroupSingleMsg(data, group_id, message_id),

        getAiCharacters: (group_id, chat_type) => this.getAiCharacters(data, group_id, chat_type),
        sendGroupAiRecord: (group_id, character, text) => this.sendGroupAiRecord(data, group_id, character, text),
        clickInlineKeyboardButton: params => this.clickInlineKeyboardButton(data, params),

        getRkey: domain => this.getRkey(data, domain),
        ncGetRkey: this.ncGetRkey.bind(this, data),
        getClientkey: this.getClientkey.bind(this, data),
        getCredentials: domain => this.getCredentials(data, domain),
        getRobotUinRange: this.getRobotUinRange.bind(this, data),
        ncGetPacketStatus: this.ncGetPacketStatus.bind(this, data),
        ncGetUserStatus: user_id => this.ncGetUserStatus(data, user_id),
        sendPacket: (cmd, packet) => this.sendPacket(data, cmd, packet),

        createCollection: params => this.createCollection(data, params),
        getCollectionList: params => this.getCollectionList(data, params),

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

        const preName = (seg.name || seg.file || "").toLowerCase()
        if (preName && !preName.endsWith(".json")) continue

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
          break
        case "group_msg_emoji_like":
          Bot.makeLog("info", [`群消息回应：${data.message_id}`, data.likes], `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
          break
        case "friend_add":
          Bot.makeLog("info", "好友添加", `${data.self_id} <= ${data.user_id}`, true)
          data.bot
            .pickFriend(data.user_id)
            .getInfo()
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
              break
            case "title":
              Bot.makeLog("info", `群头衔：${data.title}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
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
          break
        case "essence":
          data.notice_type = "group_essence"
          Bot.makeLog("info", `群精华消息：${data.operator_id} => ${data.sender_id} ${data.sub_type} ${data.message_id}`, `${data.self_id} <= ${data.group_id}`, true)
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
