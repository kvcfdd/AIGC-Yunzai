import { ulid } from "ulid"
import log from "../helpers/log.js"
import { embedTexts, isEmbeddingAvailable, resolveEmbeddingConfig } from "../embeddings/index.js"
import { resolveKnowledgeConfig } from "./config.js"
import { chunkDocument } from "./chunk.js"
import { cleanFileName, cleanStaleTempFiles, parseFile, parseUrl } from "./parse.js"
import { formatSearchResults, searchKnowledge } from "./retrieve.js"
import * as store from "./store.js"

const TASK_TTL = 60 * 60 * 1000
const MAX_TASKS = 100
const tasks = new Map()
let queue = Promise.resolve()
let tempCleaned = false

function validateVector(vector, ec) {
  if (!Array.isArray(vector) || vector.length !== ec.dimensions) throw new Error(`embedding 维度不匹配: 期望 ${ec.dimensions}，实际 ${vector?.length ?? 0}`)
  return vector
}

function publicTask(task) {
  return { id: task.id, type: task.type, kbId: task.kbId, label: task.label, status: task.status, stage: task.stage, progress: task.progress, error: task.error, result: task.result, createdAt: task.createdAt, updatedAt: task.updatedAt }
}

function updateTask(task, patch) {
  Object.assign(task, patch, { updatedAt: Date.now() })
}

function purgeTasks() {
  const cutoff = Date.now() - TASK_TTL
  for (const [id, task] of tasks) {
    if (task.status !== "running" && task.status !== "queued" && task.createdAt < cutoff) tasks.delete(id)
  }
  if (tasks.size <= MAX_TASKS) return
  for (const [id, task] of tasks) {
    if (tasks.size <= MAX_TASKS) break
    if (task.status !== "running" && task.status !== "queued") tasks.delete(id)
  }
}

async function ensureTempClean() {
  if (tempCleaned) return
  tempCleaned = true
  await cleanStaleTempFiles()
}

/** 任务串行执行，避免多个导入同时打爆 Embedding 接口；状态可轮询 */
function startTask(type, kbId, label, runner) {
  purgeTasks()
  const task = { id: ulid(), type, kbId, label, status: "queued", stage: "排队中", progress: 0, error: null, result: null, createdAt: Date.now(), updatedAt: Date.now() }
  tasks.set(task.id, task)

  queue = queue.then(async () => {
    updateTask(task, { status: "running", stage: "开始处理", progress: 1 })
    try {
      const result = await runner(task)
      updateTask(task, { status: "done", stage: "已完成", progress: 100, result: result || null })
    } catch (err) {
      updateTask(task, { status: "error", stage: "失败", error: err.message || String(err) })
      log.warn(`知识库任务失败 (${type}): ${err.message}`)
    }
  })

  return publicTask(task)
}

/** 解析 → 分块 → 向量化 → 单事务写入 */
async function runIngest(task, { kbId, parsed, sourceType, source, size, config }) {
  const kc = resolveKnowledgeConfig(config)
  const ec = resolveEmbeddingConfig(config)
  // 块长不超过向量模型单条输入上限，避免入库块只被嵌入前半截
  const chunkSize = ec ? Math.min(kc.chunkSize, ec.maxInputChars) : kc.chunkSize
  const dbh = store.openKbDb()
  // 任务排队/执行期间知识库可能已被删除，提前失败避免无谓的解析与向量化
  if (!store.getKbById(dbh, kbId)) throw new Error("知识库已被删除")

  updateTask(task, { stage: "分块中", progress: 15 })
  const chunks = chunkDocument({ text: parsed.text, markdown: parsed.markdown, size: chunkSize, overlap: Math.min(kc.chunkOverlap, chunkSize - 1) })
  if (!chunks.length) throw new Error("文档解析后没有可用内容")

  updateTask(task, { stage: "向量化中", progress: 25 })
  let vectors = null
  if (ec) {
    const texts = chunks.map(chunk => `${parsed.title}\n\n${chunk.content}`)
    vectors = await embedTexts(texts, { config, taskType: "document" })
    if (vectors.length !== chunks.length) throw new Error(`embedding 返回数量不匹配: ${vectors.length}/${chunks.length}`)
    for (const vector of vectors) validateVector(vector, ec)
    updateTask(task, { progress: 85 })
  } else {
    updateTask(task, { progress: 60 })
  }

  updateTask(task, { stage: "写入中", progress: 90 })
  if (vectors) {
    const ready = await store.ensureVectorTable(dbh, ec)
    if (!ready) throw new Error("sqlite-vec 不可用，无法写入向量")
  }

  const doc = {
    id: ulid(),
    kb_id: kbId,
    name: parsed.title || cleanFileName(source),
    source_type: sourceType,
    source,
    mime: parsed.mime || "",
    size,
    chunk_count: chunks.length,
    vector_count: vectors?.length || 0,
    created_at: Date.now(),
  }
  store.insertDocument(dbh, doc, chunks, vectors)
  return { doc_id: doc.id, name: doc.name, chunk_count: chunks.length, vector_count: doc.vector_count }
}

function requireKb(key) {
  const dbh = store.openKbDb()
  const kb = store.findKb(dbh, key)
  if (!kb) throw new Error("知识库不存在")
  return { dbh, kb }
}

export function isEnabled(config) {
  return !!config?.aigc?.knowledge?.enable
}

export function getOverview(config) {
  purgeTasks()
  const dbh = store.openKbDb()
  return {
    enabled: isEnabled(config),
    mode: resolveKnowledgeConfig(config).mode,
    embedding: isEmbeddingAvailable(config),
    kbs: store.listKbs(dbh),
    tasks: [...tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
      .map(publicTask),
  }
}

export function findKb(key) {
  return store.findKb(store.openKbDb(), key)
}

/** 是否有任何已入库文本块 */
export function hasChunks() {
  return store.kbIdsWithChunks(store.openKbDb()).length > 0
}

export function createKb({ name, description } = {}) {
  return store.createKb(store.openKbDb(), { name, description })
}

export function updateKb(key, patch = {}) {
  const dbh = store.openKbDb()
  const kb = store.findKb(dbh, key)
  if (!kb) throw new Error("知识库不存在")
  return store.updateKb(dbh, kb.id, patch)
}

export async function deleteKb(key) {
  const { dbh, kb } = requireKb(key)
  await store.loadVecExtension(dbh)
  store.deleteKb(dbh, kb.id)
  return kb
}

export function listDocuments(key) {
  const { dbh, kb } = requireKb(key)
  return store.listDocuments(dbh, kb.id)
}

export async function deleteDocument(key, docId) {
  const { dbh, kb } = requireKb(key)
  const doc = store.getDocument(dbh, kb.id, docId)
  if (!doc) throw new Error("文档不存在")
  await store.loadVecExtension(dbh)
  store.deleteDocument(dbh, kb.id, docId)
  return doc
}

/** 文件导入：上传、解析、向量化全部在后台任务中完成 */
export function startFileImport({ kbId, name, buffer, mime = "", config } = {}) {
  const { kb } = requireKb(kbId)
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("文件内容为空")
  const kc = resolveKnowledgeConfig(config)
  if (buffer.length > kc.maxFileMb * 1024 * 1024) throw new Error(`文件超过 ${kc.maxFileMb}MB 限制`)

  const label = cleanFileName(name)
  return startTask("import", kb.id, label, async task => {
    await ensureTempClean()
    updateTask(task, { stage: "解析中", progress: 5 })
    const parsed = await parseFile({ name, buffer, mime })
    return runIngest(task, { kbId: kb.id, parsed, sourceType: "file", source: label, size: buffer.length, config })
  })
}

/** 网页导入：抓取正文后走同一套分块与向量化 */
export function startUrlImport({ kbId, url, config } = {}) {
  const { kb } = requireKb(kbId)
  const target = String(url || "").trim()
  if (!/^https?:\/\/[^\s]+$/i.test(target)) throw new Error("URL 必须以 http:// 或 https:// 开头")

  return startTask("import", kb.id, target, async task => {
    await ensureTempClean()
    updateTask(task, { stage: "解析中", progress: 5 })
    const parsed = await parseUrl(target)
    return runIngest(task, { kbId: kb.id, parsed, sourceType: "url", source: target, size: Buffer.byteLength(parsed.text, "utf8"), config })
  })
}

/** 向量模型或维度变化后，为缺失向量的文档重建索引 */
export function startReindex({ kbId, config } = {}) {
  const { kb } = requireKb(kbId)
  const ec = resolveEmbeddingConfig(config)
  if (!ec) throw new Error("未启用向量模型（aigc.embeddings）")

  return startTask("reindex", kb.id, kb.name, async task => {
    const dbh = store.openKbDb()
    const ready = await store.ensureVectorTable(dbh, ec)
    if (!ready) throw new Error("sqlite-vec 不可用，无法重建向量")

    // ensureVectorTable 可能刚清空旧向量，必须之后重新读取文档计数
    const docs = store.listDocuments(dbh, kb.id)
    let processed = 0
    let reindexed = 0
    for (const doc of docs) {
      processed++
      if (!doc.chunk_count || doc.vector_count >= doc.chunk_count) continue
      const chunks = store.chunksForDoc(dbh, doc.id)
      if (!chunks.length) continue

      updateTask(task, { stage: `向量化: ${doc.name}`, progress: Math.max(1, Math.round((processed / docs.length) * 90)) })
      const vectors = await embedTexts(
        chunks.map(chunk => `${doc.name}\n\n${chunk.content}`),
        { config, taskType: "document" },
      )
      if (vectors.length !== chunks.length) throw new Error(`embedding 返回数量不匹配: ${vectors.length}/${chunks.length}`)
      for (const vector of vectors) validateVector(vector, ec)
      store.replaceDocVectors(dbh, doc, chunks, vectors)
      reindexed++
    }
    return { documents: docs.length, reindexed }
  })
}

export function getTask(id) {
  purgeTasks()
  const task = tasks.get(String(id || ""))
  return task ? publicTask(task) : null
}

/** 检索入口 — 工具与网页检索测试共用 */
export function search(query, { config, kbIds, topK, signal } = {}) {
  return searchKnowledge(query, { config, kbIds, topK, signal })
}

export { formatSearchResults, resolveKnowledgeConfig, resolveEmbeddingConfig }
export default { isEnabled, getOverview, findKb, hasChunks, createKb, updateKb, deleteKb, listDocuments, deleteDocument, startFileImport, startUrlImport, startReindex, getTask, search, formatSearchResults, resolveKnowledgeConfig }
