import { geminiUrl, apiErrorFrom, readJson } from "../llm/gemini/http.js"

/** 归一化为单位向量 */
function normalizeVector(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  return norm > 0 ? vector.map(value => value / norm) : vector
}

/** Gemini embedding：标准 v1beta models.batchEmbedContents */
export default {
  async embed(texts, { config, apiKey, dispatcher, signal, taskType, timeoutMs }) {
    const model = String(config.embeddingModel || "").replace(/^models\//, "")

    // Gemini Embedding 2 不支持 task_type，需改用文本前缀
    const isEmbedding2 = /gemini-embedding-2/.test(model)
    const requests = texts.map(text => {
      const content = isEmbedding2 ? (taskType === "query" ? `task: search result | query: ${text}` : `title: none | text: ${text}`) : text
      return {
        model: `models/${model}`,
        content: { parts: [{ text: content }] },
        ...(isEmbedding2 ? {} : { taskType: taskType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" }),
        ...(config.dimensions ? { outputDimensionality: config.dimensions } : {}),
        ...(config.extra_body || {}),
      }
    })

    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const res = await fetch(geminiUrl(config.base_url, `/models/${encodeURIComponent(model)}:batchEmbedContents`), {
      method: "POST",
      headers: {
        ...(config.headers || {}),
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({ requests }),
      signal: requestSignal,
      dispatcher,
    })

    if (!res.ok) throw await apiErrorFrom(res)
    const data = await readJson(res)
    return (data.embeddings || []).map(item => normalizeVector(item.values || []))
  },
}
