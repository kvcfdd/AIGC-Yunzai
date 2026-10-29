import OpenAI from "openai"

/** OpenAI 兼容 /embeddings：OpenAI、DeepSeek 兼容层、Qwen、SiliconFlow 等 */
export default {
  async embed(texts, { config, apiKey, dispatcher, signal, timeoutMs }) {
    const fetchImpl = dispatcher ? (input, init) => fetch(input, { ...(init || {}), dispatcher }) : undefined
    const client = new OpenAI({
      apiKey,
      baseURL: config.base_url || undefined,
      defaultHeaders: config.headers || {},
      timeout: timeoutMs,
      maxRetries: 0,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })

    const res = await client.embeddings.create(
      {
        ...(config.extra_body || {}),
        model: config.embeddingModel,
        input: texts,
        ...(config.dimensions ? { dimensions: config.dimensions } : {}),
      },
      { signal },
    )

    return (res.data || []).map(item => item.embedding)
  },
}
