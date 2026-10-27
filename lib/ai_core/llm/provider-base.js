/** LLM Provider 抽象基类 — 各后端适配器继承并实现 chat()
 *
 *  chat() 契约:
 *   options: { signal, tools, tool_choice, channel, model, ...适配器透传 }
 *   返回:    { content, tool_calls?, reasoning_content?, reasoning_parts?, blocked?, finishReason?, usage? }
 *   失败:    抛 AigcError(code) / AbortError */
class LlmProvider {
  async chat(messages, options = {}) {
    throw new Error("LlmProvider.chat not implemented")
  }
}

export default LlmProvider
