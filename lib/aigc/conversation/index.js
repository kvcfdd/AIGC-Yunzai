import sessionMethods from "./session.js"

/** 会话管理，SQLite 持久化，按用户与时间组织，轮次写入时物化
 *  方法按职责拆分于各子模块，经原型合并保持 this 互调 */
class ConversationManager {}

Object.assign(ConversationManager.prototype, sessionMethods)

export default new ConversationManager()
