import OpenAI from "openai"

const NO_DIMENSIONS = new Set()

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

    const cacheKey = `${config.base_url || ""}|${config.embeddingModel}`
    const params = withDimensions => ({
      ...(config.extra_body || {}),
      model: config.embeddingModel,
      input: texts,
      ...(withDimensions ? { dimensions: config.dimensions } : {}),
    })

    const withDimensions = !!config.dimensions && !NO_DIMENSIONS.has(cacheKey)
    let res
    try {
      res = await client.embeddings.create(params(withDimensions), { signal })
    } catch (err) {
      if (!withDimensions || (err?.status !== 400 && err?.status !== 422)) throw err
      res = await client.embeddings.create(params(false), { signal })
      NO_DIMENSIONS.add(cacheKey)
    }

    return (res.data || []).map(item => item.embedding)
  },
}
