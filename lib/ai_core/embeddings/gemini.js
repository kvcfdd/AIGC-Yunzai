import { GoogleGenAI } from "@google/genai"

/** 归一化为单位向量 */
function normalizeVector(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  return norm > 0 ? vector.map(value => value / norm) : vector
}

/** Gemini embedding：标准 v1beta models.embedContent */
export default {
  async embed(texts, { config, apiKey, dispatcher, signal, taskType, timeoutMs }) {
    const apiVersion = config.api_version || "v1beta"
    let baseUrl = (config.base_url || "https://generativelanguage.googleapis.com").replace(/\/+$/, "")
    if (baseUrl.endsWith(`/${apiVersion}`)) baseUrl = baseUrl.slice(0, -(apiVersion.length + 1))

    const fetchImpl = dispatcher ? (input, init) => fetch(input, { ...(init || {}), dispatcher }) : undefined
    const client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        baseUrl,
        apiVersion,
        headers: config.headers || {},
        timeout: timeoutMs,
        retryOptions: { attempts: 1 },
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      },
    })

    // Gemini Embedding 2 不支持 task_type，需改用文本前缀
    const isEmbedding2 = /gemini-embedding-2/.test(config.embeddingModel)
    const contents = isEmbedding2 ? texts.map(text => (taskType === "query" ? `task: search result | query: ${text}` : `title: none | text: ${text}`)) : texts

    const res = await client.models.embedContent({
      model: config.embeddingModel,
      contents,
      config: {
        ...(isEmbedding2 ? {} : { taskType: taskType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" }),
        ...(config.dimensions ? { outputDimensionality: config.dimensions } : {}),
        abortSignal: signal,
        ...(config.extra_body || {}),
      },
    })

    return (res.embeddings || []).map(item => normalizeVector(item.values || []))
  },
}
