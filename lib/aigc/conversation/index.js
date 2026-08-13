import sessionMethods from "./session.js"
import memoryMethods from "./memory.js"
import activeMethods from "./active.js"
import interactionMethods from "./interaction.js"

/** 会话管理，LevelDB 持久化，按日期分键
 *  方法按职责拆分于各子模块，经原型合并保持 this 互调 */
class ConversationManager {}

Object.assign(ConversationManager.prototype, sessionMethods, memoryMethods, activeMethods, interactionMethods)

export default new ConversationManager()
