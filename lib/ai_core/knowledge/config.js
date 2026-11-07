/** 知识库配置 — 与 aigc.embeddings 共用向量模型，知识库只负责文档侧参数 */

const DEFAULT_CHUNK_SIZE = 512
const DEFAULT_CHUNK_OVERLAP = 50
const DEFAULT_TOP_K_DENSE = 50
const DEFAULT_TOP_K_SPARSE = 50
const DEFAULT_TOP_K_FUSION = 20
const DEFAULT_TOP_M_FINAL = 5
const DEFAULT_DENSE_WEIGHT = 0.9
const DEFAULT_MAX_FILE_MB = 20
const DEFAULT_RERANK_TOP_N = 5

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

function clampFloat(value, fallback, min, max) {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

/** aigc.knowledge → 带默认值与范围钳制的运行配置 */
export function resolveKnowledgeConfig(config) {
  const kc = config?.aigc?.knowledge || {}
  const chunkSize = clampInt(kc.chunk_size, DEFAULT_CHUNK_SIZE, 100, 4000)
  const rerank = kc.rerank || {}
  const mode = String(kc.retrieval_mode || "tool")
    .trim()
    .toLowerCase()

  return {
    enable: !!kc.enable,
    mode: mode === "auto" ? "auto" : "tool",
    chunkSize,
    chunkOverlap: clampInt(kc.chunk_overlap, DEFAULT_CHUNK_OVERLAP, 0, Math.min(1000, chunkSize - 1)),
    topKDense: clampInt(kc.top_k_dense, DEFAULT_TOP_K_DENSE, 1, 200),
    topKSparse: clampInt(kc.top_k_sparse, DEFAULT_TOP_K_SPARSE, 1, 200),
    topKFusion: clampInt(kc.top_k_fusion, DEFAULT_TOP_K_FUSION, 1, 200),
    topMFinal: clampInt(kc.top_m_final, DEFAULT_TOP_M_FINAL, 1, 20),
    denseWeight: clampFloat(kc.dense_weight, DEFAULT_DENSE_WEIGHT, 0, 1),
    minSimilarity: clampFloat(kc.min_similarity, 0, 0, 1),
    maxFileMb: clampInt(kc.max_file_mb, DEFAULT_MAX_FILE_MB, 1, 200),
    rerank: {
      enable: !!rerank.enable,
      modelConfig: String(rerank.model_config || "").trim(),
      topN: clampInt(rerank.top_n, DEFAULT_RERANK_TOP_N, 1, 50),
    },
  }
}
