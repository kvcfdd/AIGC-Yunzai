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
    ...(res.response_id && { response_id: res.response_id }),
  }
}

/**
 * 构建 user 消息的公共元数据
 */
export function buildUserMessageMeta(e) {
  const meta = {
    time: Date.now(),
    chat_type: e.isGroup ? "群聊" : "私聊",
  }
  if (e.isGroup) meta.group_name = e.group_name || ""
  // 合成注入来源随 user 消息落盘，历史回放/检索可区分系统注入与用户发言
  if (e._injected) meta.inject_source = e._inject_source || "inject"
  return meta
}
