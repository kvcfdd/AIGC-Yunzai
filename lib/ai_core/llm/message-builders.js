/** 输出效验 — 清除学舌的引用前缀 */
export function stripQuotePrefix(text) {
  if (typeof text !== "string" || !text) return text
  return text.replace(/^\[引用[^\]]*\]\s*/, "").trim()
}

/**
 * 从 provider 响应构建待持久化的 assistant 消息对象
 */
export function buildAssistantMessage(res) {
  return {
    role: "assistant",
    content: res.content || null,
    ...(res.tool_calls && { tool_calls: res.tool_calls }),
    ...(res.reasoning_content && {
      reasoning_content: res.reasoning_content,
    }),
    ...(res.reasoning_parts && { reasoning_parts: res.reasoning_parts }),
    // Responses API: stateless 回放需要原始 output items（含 id/call_id/encrypted_content）
    ...(res.response_items && { response_items: res.response_items }),
  }
}

/**
 *  Symbol 不会被 Object.entries / JSON 序列化，因此不进入 payload、不落库；
 *  落盘后从 DB 读回的历史消息没有该标记，回放时仍会带时间前缀 */
export const CURRENT_TURN = Symbol("current_turn")

/** 工具结果里的状态栏
 *  同样是 Symbol：适配器读取后作为独立组件发出，但不进入 payload、不落库 */
export const STATUS_BAR = Symbol("status_bar")

/**
 * 构建 user 消息的公共元数据
 */
export function buildUserMessageMeta(e) {
  const meta = {
    time: Date.now(),
    chat_type: e.isGroup ? "群聊" : "私聊",
    [CURRENT_TURN]: true,
  }
  if (e.isGroup) meta.group_name = e.group_name || ""
  // 合成注入来源随 user 消息落盘，历史回放/检索可区分系统注入与用户发言
  if (e._injected) meta.inject_source = e._inject_source || "inject"
  return meta
}
