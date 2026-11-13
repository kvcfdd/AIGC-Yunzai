import path from "node:path"
import { ulid } from "ulid"
import db from "../../db.js"

/** 知识库独立数据库：文档块、FTS 与向量都放在这里，避免污染对话记忆库 */
export const KB_DB_FILE = path.resolve("data/aigc/knowledge/kb.db")

const READY = new WeakSet()
const FTS_READY = new WeakMap()
const VEC_LOADED = new WeakSet()

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kb (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_document (
  id           TEXT PRIMARY KEY,
  kb_id        TEXT NOT NULL,
  name         TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT '',
  mime         TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  vector_count INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS kb_document_kb ON kb_document (kb_id);

CREATE TABLE IF NOT EXISTS kb_chunk (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id       TEXT NOT NULL,
  doc_id      TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  heading     TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS kb_chunk_kb_doc ON kb_chunk (kb_id, doc_id, chunk_index);
CREATE INDEX IF NOT EXISTS kb_chunk_doc ON kb_chunk (doc_id, chunk_index);

CREATE TABLE IF NOT EXISTS kb_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_fts USING fts5(
  content,
  content='kb_chunk',
  content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS kb_chunk_fts_ai AFTER INSERT ON kb_chunk BEGIN
  INSERT INTO kb_chunk_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS kb_chunk_fts_ad AFTER DELETE ON kb_chunk BEGIN
  INSERT INTO kb_chunk_fts(kb_chunk_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS kb_chunk_fts_au AFTER UPDATE ON kb_chunk BEGIN
  INSERT INTO kb_chunk_fts(kb_chunk_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO kb_chunk_fts(rowid, content) VALUES (new.id, new.content);
END;
`

function tableExists(database, name) {
  return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, char => `\\${char}`)
}

/** 打开知识库数据库并确保基础表存在 */
export function openKbDb() {
  const database = db.open(KB_DB_FILE)
  ensureSchema(database)
  return database
}

/** 建表；FTS5 不可用时关键词检索自动回退 LIKE */
export function ensureSchema(database) {
  if (READY.has(database)) return database
  database.exec(SCHEMA)
  try {
    const existed = tableExists(database, "kb_chunk_fts")
    database.exec(FTS_SCHEMA)
    if (!existed) database.exec("INSERT INTO kb_chunk_fts(kb_chunk_fts) VALUES('rebuild')")
    FTS_READY.set(database, true)
  } catch (err) {
    FTS_READY.set(database, false)
    logger.warn(`知识库 FTS5 不可用，关键词检索回退 LIKE: ${err.message}`)
  }
  READY.add(database)
  return database
}

export function hasFts(database) {
  ensureSchema(database)
  return FTS_READY.get(database) === true
}

export async function loadVecExtension(database) {
  if (VEC_LOADED.has(database)) return true
  try {
    const sqliteVec = await import("sqlite-vec")
    sqliteVec.load(database)
    VEC_LOADED.add(database)
    return true
  } catch (err) {
    logger.warn(`sqlite-vec 加载失败，知识库向量检索不可用: ${err.message}`)
    return false
  }
}

/**
 * 按当前向量模型签名准备 vec0 表。
 * 模型或维度变化时旧向量无法比较，直接清空并标记待重建；文档块与 FTS 不受影响。
 */
export async function ensureVectorTable(database, ec) {
  if (!ec) return false
  if (!(await loadVecExtension(database))) return false

  const signature = `${ec.adapterName}:${ec.embeddingModel}:${ec.dimensions}`
  const saved = getMeta(database, "vector_signature")
  if (saved !== signature) {
    if (tableExists(database, "kb_chunk_vec")) {
      database.exec("DROP TABLE IF EXISTS kb_chunk_vec")
      database.prepare("UPDATE kb_document SET vector_count = 0").run()
      logger.info(`知识库向量模型或维度变更，已清空旧向量索引: ${signature}`)
    }
    setMeta(database, "vector_signature", signature)
  }

  database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_vec USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    kb_id TEXT PARTITION KEY,
    embedding FLOAT[${ec.dimensions}] distance_metric=cosine
  )`)
  return true
}

export function getMeta(database, key) {
  return database.prepare("SELECT value FROM kb_meta WHERE key = ?").get(key)?.value ?? null
}

export function setMeta(database, key, value) {
  database.prepare("INSERT INTO kb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value))
}

/** 知识库统计 — 文档数/块数/向量数都从明细实时汇总 */
export function listKbs(database) {
  return database
    .prepare(
      `SELECT k.id, k.name, k.description, k.created_at, k.updated_at,
              (SELECT COUNT(*) FROM kb_document d WHERE d.kb_id = k.id) AS doc_count,
              (SELECT COUNT(*) FROM kb_chunk c WHERE c.kb_id = k.id) AS chunk_count,
              (SELECT COALESCE(SUM(d.vector_count), 0) FROM kb_document d WHERE d.kb_id = k.id) AS vector_count
         FROM kb k
        ORDER BY k.created_at ASC`,
    )
    .all()
}

export function getKbById(database, id) {
  const value = String(id || "").trim()
  if (!value) return null
  return database.prepare("SELECT * FROM kb WHERE id = ?").get(value) || null
}

/** 按 id 或名称查找知识库；id 优先 */
export function findKb(database, key) {
  const value = String(key || "").trim()
  if (!value) return null
  return getKbById(database, value) || database.prepare("SELECT * FROM kb WHERE name = ? COLLATE NOCASE LIMIT 1").get(value) || null
}

/** 知识库名称进入检索结果，控制字符与换行会污染提示词格式 */
function cleanKbName(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function createKb(database, { name, description = "" } = {}) {
  const cleanName = cleanKbName(name)
  if (!cleanName) throw new Error("知识库名称不能为空")
  if (cleanName.length > 64) throw new Error("知识库名称不能超过 64 个字符")
  const now = Date.now()
  const id = ulid()
  try {
    database.prepare("INSERT INTO kb (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      cleanName,
      String(description || "")
        .trim()
        .slice(0, 500),
      now,
      now,
    )
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new Error(`知识库名称已存在: ${cleanName}`)
    throw err
  }
  return getKbById(database, id)
}

export function updateKb(database, id, { name, description } = {}) {
  const current = getKbById(database, id)
  if (!current) throw new Error("知识库不存在")
  const nextName = name == null ? current.name : cleanKbName(name)
  if (!nextName) throw new Error("知识库名称不能为空")
  if (nextName.length > 64) throw new Error("知识库名称不能超过 64 个字符")
  const nextDescription = description == null ? current.description : String(description).trim().slice(0, 500)
  try {
    database.prepare("UPDATE kb SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(nextName, nextDescription, Date.now(), id)
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new Error(`知识库名称已存在: ${nextName}`)
    throw err
  }
  return getKbById(database, id)
}

/** 删除知识库：元数据优先，随后块/FTS/向量；整体在一个事务内完成 */
export function deleteKb(database, id) {
  // vec0 是虚拟表：新连接未加载 sqlite-vec 时不能 prepare，跳过向量清理由调用方预先 load
  const vec = VEC_LOADED.has(database) && tableExists(database, "kb_chunk_vec") ? database.prepare("DELETE FROM kb_chunk_vec WHERE kb_id = ?") : null
  const tx = database.transaction(() => {
    database.prepare("DELETE FROM kb_document WHERE kb_id = ?").run(id)
    database.prepare("DELETE FROM kb_chunk WHERE kb_id = ?").run(id)
    vec?.run(id)
    return database.prepare("DELETE FROM kb WHERE id = ?").run(id).changes
  })
  return tx()
}

export function listDocuments(database, kbId) {
  return database.prepare("SELECT id, kb_id, name, source_type, source, mime, size, chunk_count, vector_count, created_at FROM kb_document WHERE kb_id = ? ORDER BY created_at DESC").all(kbId)
}

export function getDocument(database, kbId, docId) {
  return database.prepare("SELECT * FROM kb_document WHERE kb_id = ? AND id = ?").get(kbId, docId) || null
}

export function countChunks(database, kbId) {
  return database.prepare("SELECT COUNT(*) AS n FROM kb_chunk WHERE kb_id = ?").get(kbId)?.n || 0
}

export function chunksForDoc(database, docId) {
  return database.prepare("SELECT id, chunk_index, heading, content FROM kb_chunk WHERE doc_id = ? ORDER BY chunk_index").all(docId)
}

export function getChunksByIds(database, ids) {
  const list = [...new Set((ids || []).map(Number).filter(Number.isFinite))]
  if (!list.length) return []
  const marks = list.map(() => "?").join(",")
  return database
    .prepare(
      `SELECT c.id, c.kb_id, c.doc_id, c.chunk_index, c.heading, c.content,
              d.name AS doc_name, k.name AS kb_name
         FROM kb_chunk c
         JOIN kb_document d ON d.id = c.doc_id
         JOIN kb k ON k.id = c.kb_id
        WHERE c.id IN (${marks})`,
    )
    .all(...list)
}

/**
 * 文档块与向量一次事务写入。
 * 向量在调用前已全部生成并校验；任何一步失败都会整体回滚，不留下孤儿数据。
 */
export function insertDocument(database, doc, chunks, vectors = null) {
  const insertDoc = database.prepare("INSERT INTO kb_document (id, kb_id, name, source_type, source, mime, size, chunk_count, vector_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
  const insertChunk = database.prepare("INSERT INTO kb_chunk (kb_id, doc_id, chunk_index, heading, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
  const vectorReady = tableExists(database, "kb_chunk_vec")
  if (vectors?.length && !vectorReady) throw new Error("向量索引表不可用，无法写入向量")
  // 无向量时不要 prepare vec0 语句：未加载扩展的连接会报 no such module
  const insertVec = vectors?.length ? database.prepare("INSERT INTO kb_chunk_vec (chunk_id, kb_id, embedding) VALUES (?, ?, ?)") : null
  const kbExists = database.prepare("SELECT 1 FROM kb WHERE id = ?")

  const tx = database.transaction(() => {
    // 后台导入期间知识库可能已被删除：整批回滚，避免留下孤儿文档与块
    if (!kbExists.get(doc.kb_id)) throw new Error("知识库已被删除")
    insertDoc.run(doc.id, doc.kb_id, doc.name, doc.source_type, doc.source || "", doc.mime || "", Number(doc.size) || 0, chunks.length, vectors?.length || 0, doc.created_at)
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = Number(insertChunk.run(doc.kb_id, doc.id, i, chunks[i].heading || "", chunks[i].content, doc.created_at).lastInsertRowid)
      if (vectors?.[i] && insertVec) insertVec.run(BigInt(chunkId), doc.kb_id, JSON.stringify(vectors[i]))
    }
    database.prepare("UPDATE kb SET updated_at = ? WHERE id = ?").run(Date.now(), doc.kb_id)
  })
  tx()
}

/** 删除文档：先删元数据，再删块/FTS 与向量，事务保证一致 */
export function deleteDocument(database, kbId, docId) {
  const ids = database
    .prepare("SELECT id FROM kb_chunk WHERE kb_id = ? AND doc_id = ?")
    .all(kbId, docId)
    .map(row => row.id)
  const vec = VEC_LOADED.has(database) && tableExists(database, "kb_chunk_vec") ? database.prepare("DELETE FROM kb_chunk_vec WHERE chunk_id = ?") : null
  const tx = database.transaction(() => {
    const removed = database.prepare("DELETE FROM kb_document WHERE kb_id = ? AND id = ?").run(kbId, docId).changes
    database.prepare("DELETE FROM kb_chunk WHERE kb_id = ? AND doc_id = ?").run(kbId, docId)
    if (vec) for (const id of ids) vec.run(BigInt(id))
    database.prepare("UPDATE kb SET updated_at = ? WHERE id = ?").run(Date.now(), kbId)
    return removed
  })
  return tx()
}

/** 重排/补建向量：替换指定文档的全部向量并刷新计数 */
export function replaceDocVectors(database, doc, chunks, vectors) {
  const del = database.prepare("DELETE FROM kb_chunk_vec WHERE chunk_id = ?")
  const ins = database.prepare("INSERT INTO kb_chunk_vec (chunk_id, kb_id, embedding) VALUES (?, ?, ?)")
  const docExists = database.prepare("SELECT 1 FROM kb_document WHERE id = ?")
  const tx = database.transaction(() => {
    // 重建期间文档可能已被删除：跳过写入，避免产生指向已删除块的向量
    if (!docExists.get(doc.id)) return
    for (let i = 0; i < chunks.length; i++) {
      del.run(BigInt(chunks[i].id))
      ins.run(BigInt(chunks[i].id), doc.kb_id, JSON.stringify(vectors[i]))
    }
    database.prepare("UPDATE kb_document SET chunk_count = ?, vector_count = ? WHERE id = ?").run(chunks.length, vectors.length, doc.id)
  })
  tx()
}

/** FTS5 关键词检索 — 返回原始相关度（越大越好） */
export function searchFts(database, kbIds, trigrams, limit) {
  if (!kbIds.length || !trigrams.length || !hasFts(database)) return []
  const marks = kbIds.map(() => "?").join(",")
  const match = trigrams.map(term => `"${String(term).replace(/"/g, '""')}"`).join(" OR ")
  const take = Math.max(1, Math.min(1000, Number(limit) || 50))
  try {
    return database
      .prepare(
        `SELECT c.id AS chunk_id, c.kb_id, bm25(kb_chunk_fts) AS rank
           FROM kb_chunk_fts
           JOIN kb_chunk c ON c.id = kb_chunk_fts.rowid
          WHERE kb_chunk_fts MATCH ? AND c.kb_id IN (${marks})
          ORDER BY rank
          LIMIT ?`,
      )
      .all(match, ...kbIds, take)
      .map(row => ({ chunkId: Number(row.chunk_id), kbId: row.kb_id, score: -Number(row.rank) }))
  } catch (err) {
    logger.warn(`知识库 FTS 查询失败，回退 LIKE: ${err.message}`)
    return []
  }
}

/** 短词（2 字）回退 LIKE，并按词命中数给一个相对分数 */
export function searchLike(database, kbIds, terms, limit) {
  if (!kbIds.length || !terms.length) return []
  const marks = kbIds.map(() => "?").join(",")
  const clauses = terms.map(() => "content LIKE ? ESCAPE '\\'")
  const take = Math.max(1, Math.min(1000, Number(limit) || 50))
  const rows = database.prepare(`SELECT id AS chunk_id, kb_id, content FROM kb_chunk WHERE kb_id IN (${marks}) AND (${clauses.join(" OR ")}) LIMIT ?`).all(...kbIds, ...terms.map(term => `%${escapeLike(term)}%`), take)
  const lowered = terms.map(term => String(term).toLowerCase())
  return rows.map(row => {
    const content = String(row.content || "").toLowerCase()
    const score = lowered.reduce((sum, term) => sum + (content.includes(term) ? 1 : 0), 0)
    return { chunkId: Number(row.chunk_id), kbId: row.kb_id, score }
  })
}

/** 单库向量 KNN — 分区过滤由 vec0 的 PARTITION KEY 完成 */
export function searchVectors(database, kbId, vector, limit) {
  const take = Math.max(1, Math.min(500, Number(limit) || 50))
  try {
    return database
      .prepare(`SELECT chunk_id, distance FROM kb_chunk_vec WHERE embedding MATCH ? AND k = ${take} AND kb_id = ? ORDER BY distance`)
      .all(JSON.stringify(vector), kbId)
      .map(row => ({ chunkId: Number(row.chunk_id), kbId, score: Math.max(-1, Math.min(1, 1 - Number(row.distance))), distance: Number(row.distance) }))
  } catch (err) {
    logger.warn(`知识库向量查询失败: ${err.message}`)
    return []
  }
}

/** 知识库中存在文本块的库 id */
export function kbIdsWithChunks(database) {
  return database
    .prepare("SELECT DISTINCT kb_id FROM kb_chunk")
    .all()
    .map(row => row.kb_id)
}

/** 指定知识库是否已有向量 */
export function hasVectors(database, kbIds) {
  if (!kbIds.length) return false
  const marks = kbIds.map(() => "?").join(",")
  return (database.prepare(`SELECT COALESCE(SUM(vector_count), 0) AS n FROM kb_document WHERE kb_id IN (${marks})`).get(...kbIds)?.n || 0) > 0
}
