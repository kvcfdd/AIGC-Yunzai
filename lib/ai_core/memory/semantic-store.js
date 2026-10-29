import db, { DEFAULT_FILE } from "../../db.js"
import cfg from "../../config/config.js"
import log from "../helpers/log.js"
import { embedTexts, resolveEmbeddingConfig } from "../embeddings/index.js"

const LOADED = new WeakSet()
const MAX_K = 200
const MAX_BACKFILL = 2000
const RRF_K = 60

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

function openDatabase(database) {
  return database || db.open(cfg.db?.storage || DEFAULT_FILE)
}

function tableExists(database, name) {
  return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/** 删除向量行；vec0 是虚拟表，必须先加载扩展 */
async function deleteVecRows(database, ids) {
  if (!ids.length || !tableExists(database, "aigc_turn_vec")) return
  if (!(await ensureVecExtension(database))) return
  const del = database.prepare("DELETE FROM aigc_turn_vec WHERE turn_id = ?")
  database.transaction(() => {
    for (const id of ids) del.run(BigInt(id))
  })()
}

/** 每个用户一份向量分区，保证跨用户隔离 */
function scopeOf(sid) {
  return `${sid.self_id}:${sid.user_id}`
}

/** 加载 sqlite-vec；不可用时语义检索自动降级为关键词 */
async function ensureVecExtension(database) {
  if (LOADED.has(database)) return true
  try {
    const sqliteVec = await import("sqlite-vec")
    sqliteVec.load(database)
    LOADED.add(database)
    return true
  } catch (err) {
    log.warn(`sqlite-vec 加载失败，语义检索不可用: ${err.message}`)
    return false
  }
}

/** 建表；模型/维度变更时清空旧索引，等待重新补建 */
function ensureSchema(database, ec) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS aigc_turn_index (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      self_id    TEXT    NOT NULL,
      user_id    TEXT    NOT NULL,
      turn       INTEGER NOT NULL,
      content    TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (self_id, user_id, turn)
    );
    CREATE INDEX IF NOT EXISTS aigc_turn_index_user_time ON aigc_turn_index (self_id, user_id, created_at);
    CREATE TABLE IF NOT EXISTS aigc_semantic_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  const signature = `${ec.api}:${ec.embeddingModel}:${ec.dimensions}:cosine`
  const saved = database.prepare("SELECT value FROM aigc_semantic_meta WHERE key = 'signature'").get()
  if (saved?.value !== signature) {
    database.exec("DROP TABLE IF EXISTS aigc_turn_vec")
    database.exec("DELETE FROM aigc_turn_index")
    database.prepare("INSERT INTO aigc_semantic_meta (key, value) VALUES ('signature', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(signature)
    if (saved) log.info(`向量模型或维度变更，已清空旧语义索引: ${signature}`)
  }

  database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS aigc_turn_vec USING vec0(
    turn_id INTEGER PRIMARY KEY,
    scope TEXT PARTITION KEY,
    embedding FLOAT[${ec.dimensions}] distance_metric=cosine
  )`)
}

function validateVector(vector, ec) {
  if (!Array.isArray(vector) || vector.length !== ec.dimensions) {
    throw new Error(`embedding 维度不匹配: 期望 ${ec.dimensions}，实际 ${vector?.length ?? 0}；请调整 aigc.embeddings.dimensions`)
  }
  return vector
}

function turnRows(database, sid, turn) {
  return database.prepare("SELECT role, content, created_at FROM aigc_message WHERE self_id = ? AND user_id = ? AND turn = ? AND role IN ('user','assistant') ORDER BY id").all(sid.self_id, sid.user_id, turn)
}

/** 一轮对话 → 供 embedding 的文本；跳过空内容与 no_reply */
export function buildTurnText(rows, maxChars = 2000) {
  const lines = []
  for (const row of rows) {
    const content = String(row.content ?? "")
      .replace(/<\/?(?:xix|voice)>/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
    if (!content || /^no_reply$/i.test(content)) continue
    lines.push(`${row.role === "user" ? "用户" : "助手"}: ${content}`)
  }
  const text = lines.join("\n")
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

function existingIndexRow(database, sid, turn) {
  return database.prepare("SELECT id, content FROM aigc_turn_index WHERE self_id = ? AND user_id = ? AND turn = ?").get(sid.self_id, sid.user_id, turn) || null
}

/** 写入索引行与向量（同一事务）；已存在则同步更新内容，避免轮次号复用后张冠李戴 */
function storeVectors(database, sid, items) {
  const find = database.prepare("SELECT id FROM aigc_turn_index WHERE self_id = ? AND user_id = ? AND turn = ?")
  const insertIndex = database.prepare("INSERT INTO aigc_turn_index (self_id, user_id, turn, content, created_at) VALUES (?, ?, ?, ?, ?)")
  const updateIndex = database.prepare("UPDATE aigc_turn_index SET content = ?, created_at = ? WHERE id = ?")
  const delVec = database.prepare("DELETE FROM aigc_turn_vec WHERE turn_id = ?")
  const insVec = database.prepare("INSERT INTO aigc_turn_vec (turn_id, scope, embedding) VALUES (?, ?, ?)")
  const scope = scopeOf(sid)

  database.transaction(() => {
    for (const item of items) {
      let id = find.get(sid.self_id, sid.user_id, item.turn)?.id
      if (id) updateIndex.run(item.text, item.createdAt, id)
      else id = Number(insertIndex.run(sid.self_id, sid.user_id, item.turn, item.text, item.createdAt).lastInsertRowid)
      delVec.run(BigInt(id))
      insVec.run(BigInt(id), scope, JSON.stringify(item.vector))
    }
  })()
}

/**
 * 索引单轮对话（写入后异步调用）。
 * @returns {Promise<boolean>} 是否实际写入
 */
export async function indexTurn(sid, turn, { config = cfg, database, signal, embed } = {}) {
  const ec = resolveEmbeddingConfig(config)
  if (!ec) return false
  const dbh = openDatabase(database)
  if (!(await ensureVecExtension(dbh))) return false
  ensureSchema(dbh, ec)

  const rows = turnRows(dbh, sid, turn)
  const text = buildTurnText(rows, ec.maxInputChars)
  if (!text) return false
  // 内容未变说明索引已是最新；内容变了（例如清空对话后轮次号复用）则重新向量化覆盖
  if (existingIndexRow(dbh, sid, turn)?.content === text) return true

  const [vector] = await embedTexts([text], { config, signal, taskType: "document", embedOverride: embed })
  validateVector(vector, ec)
  const createdAt = Math.min(...rows.map(r => Number(r.created_at) || Date.now()))
  storeVectors(dbh, sid, [{ turn, text, vector, createdAt }])
  return true
}

/** 删除指定用户的全部语义索引（清空对话时调用） */
export async function clearUserIndex(sid, { database } = {}) {
  const dbh = openDatabase(database)
  if (!tableExists(dbh, "aigc_turn_index")) return 0
  const ids = dbh
    .prepare("SELECT id FROM aigc_turn_index WHERE self_id = ? AND user_id = ?")
    .all(sid.self_id, sid.user_id)
    .map(row => row.id)
  // 先删索引行再删向量：万一向量删除失败，留孤儿向量无害；反过来会留下"有索引无向量"的轮次
  const removed = dbh.prepare("DELETE FROM aigc_turn_index WHERE self_id = ? AND user_id = ?").run(sid.self_id, sid.user_id).changes
  await deleteVecRows(dbh, ids)
  return removed
}

/** 清空全部语义索引（管理员清空全部对话时调用） */
export async function clearAllIndex({ database } = {}) {
  const dbh = openDatabase(database)
  if (!tableExists(dbh, "aigc_turn_index")) return 0
  const removed = dbh.prepare("DELETE FROM aigc_turn_index").run().changes
  if (tableExists(dbh, "aigc_turn_vec") && (await ensureVecExtension(dbh))) dbh.exec("DELETE FROM aigc_turn_vec")
  return removed
}

/** 删除没有对应消息的孤儿索引（定期清理旧轮次后调用） */
export async function pruneOrphanIndex({ database } = {}) {
  const dbh = openDatabase(database)
  if (!tableExists(dbh, "aigc_turn_index")) return 0
  const ids = dbh
    .prepare(
      `SELECT t.id AS id
         FROM aigc_turn_index t
        WHERE NOT EXISTS (
          SELECT 1 FROM aigc_message m
           WHERE m.self_id = t.self_id AND m.user_id = t.user_id AND m.turn = t.turn
             AND m.role IN ('user','assistant')
        )`,
    )
    .all()
    .map(row => row.id)
  if (!ids.length) return 0
  // 同样先删索引行再删向量，避免中途失败留下"有索引无向量"
  const del = dbh.prepare("DELETE FROM aigc_turn_index WHERE id = ?")
  dbh.transaction(() => {
    for (const id of ids) del.run(id)
  })()
  await deleteVecRows(dbh, ids)
  return ids.length
}

/**
 * 按需补建缺失的语义索引，最近轮次优先。
 * @returns {Promise<number>} 本轮补建数量
 */
export async function backfillTurns(sid, { config = cfg, database, signal, limit, embed } = {}) {
  const ec = resolveEmbeddingConfig(config)
  if (!ec) return 0
  const dbh = openDatabase(database)
  if (!(await ensureVecExtension(dbh))) return 0
  ensureSchema(dbh, ec)

  const max = clampInt(limit ?? ec.retrieval.backfillLimit, ec.retrieval.backfillLimit, 0, MAX_BACKFILL)
  if (!max) return 0

  const missing = dbh
    .prepare(
      `SELECT m.turn, MIN(m.created_at) AS created_at
         FROM aigc_message m
         LEFT JOIN aigc_turn_index t
           ON t.self_id = m.self_id AND t.user_id = m.user_id AND t.turn = m.turn
        WHERE m.self_id = ? AND m.user_id = ?
          AND m.role IN ('user','assistant')
          AND t.id IS NULL
        GROUP BY m.turn
        ORDER BY m.turn DESC
        LIMIT ?`,
    )
    .all(sid.self_id, sid.user_id, max)
  if (!missing.length) return 0

  const items = []
  for (const row of missing) {
    const text = buildTurnText(turnRows(dbh, sid, row.turn), ec.maxInputChars)
    if (text) items.push({ turn: row.turn, text, createdAt: row.created_at })
  }
  if (!items.length) return 0

  const vectors = await embedTexts(
    items.map(item => item.text),
    { config, signal, taskType: "document", embedOverride: embed },
  )
  if (vectors.length !== items.length) throw new Error(`embedding 返回数量不匹配: ${vectors.length}/${items.length}`)
  for (const vector of vectors) validateVector(vector, ec)

  storeVectors(
    dbh,
    sid,
    items.map((item, i) => ({ ...item, vector: vectors[i] })),
  )
  log.debug(`语义索引补建 ${items.length} 轮`)
  return items.length
}

/**
 * 语义检索：返回 [{ turn, created_at, distance, score }]，按相似度升序。
 * 时间范围在 KNN 结果上过滤。
 */
export async function semanticSearch(sid, query, { config = cfg, database, signal, limit, startMs, endMs, embed } = {}) {
  const ec = resolveEmbeddingConfig(config)
  if (!ec) throw new Error("语义检索未启用：请配置 aigc.embeddings")
  const dbh = openDatabase(database)
  if (!(await ensureVecExtension(dbh))) throw new Error("sqlite-vec 不可用，无法进行语义检索")
  ensureSchema(dbh, ec)

  const [vector] = await embedTexts([query], { config, signal, taskType: "query", embedOverride: embed })
  validateVector(vector, ec)

  const take = clampInt(limit, ec.retrieval.topK, 1, 50)
  const k = Math.min(MAX_K, Math.max(take * 5, 50))
  const vecRows = dbh.prepare(`SELECT turn_id, distance FROM aigc_turn_vec WHERE embedding MATCH ? AND k = ${k} AND scope = ? ORDER BY distance`).all(JSON.stringify(vector), scopeOf(sid))
  if (!vecRows.length) return []

  const ids = vecRows.map(row => Number(row.turn_id))
  const placeholders = ids.map(() => "?").join(",")
  const indexRows = dbh.prepare(`SELECT id, turn, created_at FROM aigc_turn_index WHERE id IN (${placeholders})`).all(...ids)
  const byId = new Map(indexRows.map(row => [Number(row.id), row]))

  const out = []
  for (const row of vecRows) {
    const meta = byId.get(Number(row.turn_id))
    if (!meta) continue
    if (startMs != null && meta.created_at < startMs) continue
    if (endMs != null && meta.created_at > endMs) continue
    const score = Math.max(-1, Math.min(1, 1 - row.distance))
    if (ec.retrieval.minSimilarity > 0 && score < ec.retrieval.minSimilarity) continue
    out.push({ turn: meta.turn, created_at: meta.created_at, distance: row.distance, score })
    if (out.length >= take) break
  }
  return out
}

/** 关键词 + 语义结果 RRF 合并；入参均按各自相关度从高到低排列 */
export function mergeHybridTurns(keywordTurns, semanticTurns, limit = 10) {
  const scores = new Map()
  keywordTurns.forEach((turn, index) => scores.set(turn, (scores.get(turn) || 0) + 1 / (RRF_K + index + 1)))
  semanticTurns.forEach((item, index) => scores.set(item.turn, (scores.get(item.turn) || 0) + 1 / (RRF_K + index + 1)))
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([turn]) => turn)
}
