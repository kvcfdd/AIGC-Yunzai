/** 构建工具执行上下文 — 工具只依赖这里注入的服务，不直接 import 全局单例 */
export function createToolContext({ event, signal, services, userId }) {
  return {
    event,
    user_id: userId ?? event?.user_id,
    signal,
    config: services.config,
    memory: services.memory,
    llm: services.provider,
    tools: services.tools,
    skills: services.skills,
    redis: services.redis,
    logger: services.logger,
    bot: services.bot ?? globalThis.Bot,
    injectMessage: services.injectMessage ?? (params => globalThis.Bot.aigc.injectMessage(params)),
  }
}
