import crypto from "node:crypto"
import store from "./store.js"
import { embed, cosineSimilarity } from "./embedding.js"
import log from "./helpers/log.js"

const DOC_PREFIX = "kbd:"
const CHUNK_PREFIX = "kbc:"
const HASH_PREFIX = "kbhash:"
const SEARCH_THRESHOLD = 0.65
const SEARCH_TOP_K = 3
const CHUNK_SIZE = 512
const CHUNK_OVERLAP = 128

/** 知识库：文档分块 + 向量化存储 + 语义检索 */
class KnowledgeBase {
  constructor() {
    this._cache = null       // Map<chunkKey, embedding[]>
    this._version = 0        // 版本号，防 _ensureCache 与 _invalidate 竞态
    this._building = null    // 构建中 Promise，防并发重复构建
  }

  _invalidate() {
    this._cache = null
    this._version++
  }

  /** 按需构建内存缓存，避免每次检索都从 LevelDB 逐条读取 */
  async _ensureCache() {
    if (this._cache) return this._cache
    // 复用正在构建的 Promise，避免并发重复构建
    if (!this._building) {
      this._building = (async () => {
        const version = this._version
        const keys = await store.keys(CHUNK_PREFIX)
        if (!keys.length) {
          this._cache = new Map()
          return this._cache
        }
        const chunks = await Promise.all(keys.map(k => store.get(k)))
        const map = new Map()
        for (let i = 0; i < keys.length; i++) {
          if (chunks[i]?.embedding?.length) map.set(keys[i], chunks[i].embedding)
        }
        // 构建期间发生过失效，本次不缓存但正常返回供当前调用使用
        if (this._version !== version) return map
        this._cache = map
        return this._cache
      })().finally(() => { this._building = null })
    }
    return this._building
  }
  _docId() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }

  _contentHash(text) {
    return crypto.createHash("md5").update(text).digest("hex").slice(0, 16)
  }

  /** 按段落切分，长段落按固定窗口滑动切分 */
  _chunk(text) {
    const clean = text.replace(/\r\n/g, "\n").trim()
    if (clean.length <= CHUNK_SIZE) return [clean]

    const paragraphs = clean.split(/\n+/).map(s => s.trim()).filter(Boolean)
    const chunks = []
    let current = ""

    for (const para of paragraphs) {
      if (current.length + para.length + 1 <= CHUNK_SIZE) {
        current = current ? current + "\n" + para : para
      } else {
        if (current) chunks.push(current)
        if (para.length > CHUNK_SIZE) {
          for (let i = 0; i < para.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
            chunks.push(para.slice(i, i + CHUNK_SIZE))
          }
          current = ""
        } else {
          current = para
        }
      }
    }

    if (current) chunks.push(current)
    return chunks
  }

  /** 添加文档：内容哈希去重 → 分块 → 逐块 embed → 存入 LevelDB */
  async add(content) {
    const contentStr = String(content).trim()
    if (!contentStr || contentStr.length < 2) return { error: "内容太短" }

    const hash = this._contentHash(contentStr)
    const existing = await store.get(`${HASH_PREFIX}${hash}`)
    if (existing) return { error: "内容已存在", id: existing }

    const chunks = this._chunk(contentStr)

    let embeddings
    try {
      embeddings = await Promise.all(chunks.map(c => embed(c)))
    } catch (err) {
      log.error(`知识库 向量化失败: ${err.message}`)
      return { error: `向量化失败: ${err.message}` }
    }

    if (!embeddings[0]?.length) return { error: "未配置 Gemini API Key，知识库不可用" }

    const id = this._docId()

    await store.set(`${DOC_PREFIX}${id}`, {
      content: contentStr,
      chunkCount: chunks.length,
      createdAt: Date.now(),
    })

    await store.set(`${HASH_PREFIX}${hash}`, id)

    for (let i = 0; i < chunks.length; i++) {
      await store.set(`${CHUNK_PREFIX}${id}:${i}`, {
        content: chunks[i],
        embedding: embeddings[i],
      })
    }

    this._invalidate()
    log.info(`知识库添加文档 (${chunks.length} chunks)`)
    return { id, content: contentStr.slice(0, 60) + (contentStr.length > 60 ? "..." : "") }
  }

  async remove(id) {
    const doc = await store.get(`${DOC_PREFIX}${id}`)
    if (!doc) return { error: "文档不存在" }

    await store.del(`${DOC_PREFIX}${id}`)
    await store.del(`${HASH_PREFIX}${this._contentHash(doc.content)}`)
    for (let i = 0; i < doc.chunkCount; i++) {
      await store.del(`${CHUNK_PREFIX}${id}:${i}`)
    }

    this._invalidate()
    log.info(`知识库删除文档`)
    return { id }
  }

  async list() {
    const keys = await store.keys(DOC_PREFIX)
    if (!keys.length) return []

    const docs = []
    for (const k of keys) {
      const doc = await store.get(k)
      if (doc) {
        docs.push({
          id: k.replace(DOC_PREFIX, ""),
          content: doc.content.slice(0, 80) + (doc.content.length > 80 ? "..." : ""),
          createdAt: doc.createdAt,
        })
      }
    }
    docs.sort((a, b) => b.createdAt - a.createdAt)
    return docs
  }

  async clear() {
    await store.delByPrefix(DOC_PREFIX)
    await store.delByPrefix(CHUNK_PREFIX)
    await store.delByPrefix(HASH_PREFIX)
    this._invalidate()
    log.info(`知识库已清空`)
  }

  /** 语义检索：embed query → 遍历缓存向量 → 按 docId 去重保留最高分 → topK */
  async search(query, topK) {
    const k = topK || SEARCH_TOP_K

    // 先检查缓存是否为空，避免空 KB 时浪费 embed API 调用
    const cache = await this._ensureCache()
    if (!cache.size) return []

    let qVec
    try {
      qVec = await embed(query)
    } catch (err) {
      log.error(`知识库 搜索失败: ${err.message}`)
      return []
    }

    if (!qVec.length) return []

    // CPU 向量计算，无 I/O
    const scored = []
    for (const [key, embedding] of cache) {
      const score = cosineSimilarity(qVec, embedding)
      if (score >= SEARCH_THRESHOLD) {
        const stripped = key.slice(CHUNK_PREFIX.length)
        const docId = stripped.slice(0, stripped.lastIndexOf(":"))
        scored.push({ docId, score })
      }
    }

    // 按 docId 去重，保留最高分
    const best = new Map()
    for (const item of scored) {
      const prev = best.get(item.docId)
      if (!prev || item.score > prev.score) best.set(item.docId, item.score)
    }

    const ranked = [...best.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)

    const results = []
    for (const [docId, score] of ranked) {
      const doc = await store.get(`${DOC_PREFIX}${docId}`)
      if (doc) results.push({ id: docId, content: doc.content, score })
    }

    return results
  }

  /** 检索并格式化为系统提示词上下文 */
  async toContext(query) {
    const results = await this.search(query)
    if (!results.length) return ""

    const lines = ["\n## Relevant Knowledge Base"]
    for (const r of results) {
      lines.push(`- ${r.content}`)
    }
    log.debug(`知识库检索命中`)
    return lines.join("\n")
  }
}

export default new KnowledgeBase()
