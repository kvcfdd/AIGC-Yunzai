import db, { DEFAULT_FILE } from "../../db.js"
import cfg from "../config.js"
import log from "../helpers/log.js"
import { embedTexts, resolveEmbeddingConfig } from "../embeddings/index.js"
import { rerankDocuments } from "../knowledge/rerank.js"

const READY = new WeakSet()
const FTS_READY = new WeakMap()
const VEC_LOADED = new WeakSet()
const RRF_K = 60
const MAX_RESULTS = 5
const CANDIDATE_FACTOR = 4
const RERANK_TOP_N = 10

const SCHEMA = `
CREATE TABLE IF NOT EXISTS aigc_memory_day (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  self_id       TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  day           TEXT    NOT NULL,
  summary       TEXT    NOT NULL,
  chats         TEXT    NOT NULL DEFAULT '[]',
  is_empty      INTEGER NOT NULL DEFAULT 0,
  vector_status INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (self_id, user_id, day)
);
CREATE INDEX IF NOT EXISTS aigc_memory_day_user ON aigc_memory_day (self_id, user_id, day);
CREATE TABLE IF NOT EXISTS aigc_memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS aigc_memory_day_fts USING fts5(
  summary,
  content='aigc_memory_day',
  content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS aigc_memory_day_fts_ai AFTER INSERT ON aigc_memory_day BEGIN
  INSERT INTO aigc_memory_day_fts(rowid, summary) VALUES (new.id, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS aigc_memory_day_fts_ad AFTER DELETE ON aigc_memory_day BEGIN
  INSERT INTO aigc_memory_day_fts(aigc_memory_day_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS aigc_memory_day_fts_au AFTER UPDATE ON aigc_memory_day BEGIN
  INSERT INTO aigc_memory_day_fts(aigc_memory_day_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
  INSERT INTO aigc_memory_day_fts(rowid, summary) VALUES (new.id, new.summary);
END;
`

function tableExists(database, name) {
  return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, char => `\\${char}`)
}

/** 本地日期 → YYYY-MM-DD */
export function dayKey(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/** YYYY-MM-DD → 当天 0 点时间戳 */
export function dayStart(day) {
  const [year, month, date] = String(day || "")
    .split("-")
    .map(Number)
  if (!year || !month || !date) return 0
  return new Date(year, month - 1, date).getTime()
}

export function openDb(database) {
  return database || db.open(cfg.db?.storage || DEFAULT_FILE)
}

export function ensureSchema(database) {
  if (READY.has(database)) return database
  database.exec(SCHEMA)
  try {
    const existed = tableExists(database, "aigc_memory_day_fts")
    database.exec(FTS_SCHEMA)
    if (!existed) database.exec("INSERT INTO aigc_memory_day_fts(aigc_memory_day_fts) VALUES('rebuild')")
    FTS_READY.set(database, true)
  } catch (err) {
    FTS_READY.set(database, false)
    log.warn(`每日记忆 FTS5 不可用，关键词检索回退 LIKE: ${err.message}`)
  }
  READY.add(database)
  return database
}

function hasFts(database) {
  ensureSchema(database)
  return FTS_READY.get(database) === true
}

async function loadVecExtension(database) {
  if (VEC_LOADED.has(database)) return true
  try {
    const sqliteVec = await import("sqlite-vec")
    sqliteVec.load(database)
    VEC_LOADED.add(database)
    return true
  } catch (err) {
    log.warn(`sqlite-vec 加载失败，每日记忆向量检索不可用: ${err.message}`)
    return false
  }
}

function getMeta(database, key) {
  return database.prepare("SELECT value FROM aigc_memory_meta WHERE key = ?").get(key)?.value ?? null
}

function setMeta(database, key, value) {
  database.prepare("INSERT INTO aigc_memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value))
}

/** 按当前向量模型签名准备 vec 表；模型或维度变化时清空旧向量，总结本身保留 */
export async function ensureVectorTable(database, ec) {
  if (!ec) return false
  if (!(await loadVecExtension(database))) return false
  ensureSchema(database)

  const signature = `${ec.adapterName}:${ec.embeddingModel}:${ec.dimensions}:cosine:day`
  const saved = getMeta(database, "vector_signature")
  if (saved !== signature) {
    if (tableExists(database, "aigc_memory_day_vec")) {
      database.exec("DROP TABLE IF EXISTS aigc_memory_day_vec")
      database.prepare("UPDATE aigc_memory_day SET vector_status = 0").run()
      log.info(`每日记忆向量模型或维度变更，已清空旧向量: ${signature}`)
    }
    setMeta(database, "vector_signature", signature)
  }

  database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS aigc_memory_day_vec USING vec0(
    memory_id INTEGER PRIMARY KEY,
    scope TEXT PARTITION KEY,
    day TEXT,
    embedding FLOAT[${ec.dimensions}] distance_metric=cosine
  )`)
  return true
}

function scopeOf(sid) {
  return `${sid.self_id}:${sid.user_id}`
}

export function getSummary(database, sid, day) {
  ensureSchema(database)
  return database.prepare("SELECT * FROM aigc_memory_day WHERE self_id = ? AND user_id = ? AND day = ?").get(sid.self_id, sid.user_id, day) || null
}

/** 写入当天总结；同一天已存在则保留旧行，保证任务幂等 */
export function insertSummary(database, { sid, day, summary, chats = [], isEmpty = false }) {
  ensureSchema(database)
  const now = Date.now()
  database
    .prepare(
      `INSERT INTO aigc_memory_day (self_id, user_id, day, summary, chats, is_empty, vector_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(self_id, user_id, day) DO NOTHING`,
    )
    .run(sid.self_id, sid.user_id, day, summary, JSON.stringify(chats), isEmpty ? 1 : 0, now, now)
  return getSummary(database, sid, day)
}

export function listMissingVectors(database, sid, limit = 20) {
  ensureSchema(database)
  return database.prepare("SELECT * FROM aigc_memory_day WHERE self_id = ? AND user_id = ? AND is_empty = 0 AND vector_status = 0 ORDER BY day DESC LIMIT ?").all(sid.self_id, sid.user_id, Math.max(1, Math.min(100, Number(limit) || 20)))
}

/** 写入单条总结的向量；向量表必须已准备 */
export function storeVector(database, row, vector) {
  const del = database.prepare("DELETE FROM aigc_memory_day_vec WHERE memory_id = ?")
  const ins = database.prepare("INSERT INTO aigc_memory_day_vec (memory_id, scope, day, embedding) VALUES (?, ?, ?, ?)")
  const upd = database.prepare("UPDATE aigc_memory_day SET vector_status = 1 WHERE id = ?")
  database.transaction(() => {
    del.run(BigInt(row.id))
    ins.run(BigInt(row.id), scopeOf(row), row.day, JSON.stringify(vector))
    upd.run(row.id)
  })()
}

function validateVector(vector, ec) {
  if (!Array.isArray(vector) || vector.length !== ec.dimensions) throw new Error(`embedding 维度不匹配: 期望 ${ec.dimensions}，实际 ${vector?.length ?? 0}`)
  return vector
}

/** 为一条总结生成并写入向量；失败只记日志，总结仍可关键词检索 */
export async function embedSummary(database, row, { config = cfg, signal, embed } = {}) {
  if (!row || row.is_empty) return false
  let ec
  try {
    ec = resolveEmbeddingConfig(config)
  } catch (err) {
    log.warn(`每日记忆向量配置不可用: ${err.message}`)
    return false
  }
  if (!ec) return false
  if (!(await ensureVectorTable(database, ec))) return false
  try {
    const [vector] = await embedTexts([row.summary], { config, signal, taskType: "document", embedOverride: embed })
    validateVector(vector, ec)
    storeVector(database, row, vector)
    return true
  } catch (err) {
    if (!signal?.aborted) log.warn(`每日记忆向量化失败 (${row.self_id}:${row.user_id} ${row.day}): ${err.message}`)
    return false
  }
}

/** 补齐某个用户缺失的总结向量 */
export async function backfillSummaryVectors(sid, { database, config = cfg, signal, embed, limit = 20 } = {}) {
  const dbh = openDb(database)
  ensureSchema(dbh)
  let ec
  try {
    ec = resolveEmbeddingConfig(config)
  } catch {
    return 0
  }
  if (!ec) return 0
  const rows = listMissingVectors(dbh, sid, limit)
  let done = 0
  for (const row of rows) {
    if (signal?.aborted) break
    if (await embedSummary(dbh, row, { config, signal, embed })) done++
  }
  return done
}

/** 删除向量行；vec0 是虚拟表，必须先加载扩展 */
async function deleteSummaryVectors(database, ids) {
  if (!ids.length || !tableExists(database, "aigc_memory_day_vec")) return
  if (!(await loadVecExtension(database))) return
  const del = database.prepare("DELETE FROM aigc_memory_day_vec WHERE memory_id = ?")
  database.transaction(() => {
    for (const id of ids) del.run(BigInt(id))
  })()
}

/** 删除用户的全部每日总结；FTS 由触发器同步，向量尽力删除 */
export async function clearUserSummaries(sid, { database } = {}) {
  const dbh = openDb(database)
  ensureSchema(dbh)
  const ids = dbh
    .prepare("SELECT id FROM aigc_memory_day WHERE self_id = ? AND user_id = ?")
    .all(sid.self_id, sid.user_id)
    .map(row => row.id)
  const removed = dbh.prepare("DELETE FROM aigc_memory_day WHERE self_id = ? AND user_id = ?").run(sid.self_id, sid.user_id).changes
  await deleteSummaryVectors(dbh, ids)
  return removed
}

/** 删除全部用户的每日总结 */
export async function clearAllSummaries({ database } = {}) {
  const dbh = openDb(database)
  ensureSchema(dbh)
  const ids = dbh
    .prepare("SELECT id FROM aigc_memory_day")
    .all()
    .map(row => row.id)
  const removed = dbh.prepare("DELETE FROM aigc_memory_day").run().changes
  await deleteSummaryVectors(dbh, ids)
  return removed
}

function queryTerms(query) {
  const segments = String(query || "")
    .split(/[\s，。！？；：、,.!?;:()[\]{}"'“”‘’<>《》【】/\\|]+/)
    .map(term => term.trim())
    .filter(Boolean)
  const terms = new Set()
  for (const segment of segments) {
    const ascii = /^[\x00-\x7F]+$/.test(segment)
    if (ascii || segment.length <= 4) {
      terms.add(segment)
      continue
    }
    // 长中文句子拆 trigram，避免整句作为短语只能精确命中原句
    const step = Math.max(1, Math.floor((segment.length - 2) / 8))
    for (let i = 0; i + 2 < segment.length && terms.size < 8; i += step) terms.add(segment.slice(i, i + 3))
  }
  return [...terms].slice(0, 8)
}

function ftsQuery(terms) {
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(" OR ")
}

function parseChats(value) {
  try {
    const list = JSON.parse(value || "[]")
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function rowOut(row) {
  return {
    id: Number(row.id),
    day: row.day,
    summary: row.summary,
    chats: parseChats(row.chats),
    created_at: Number(row.created_at) || 0,
  }
}

/** 关键词检索；query 为空时按日期倒序取当天范围内的总结 */
function keywordSearch(database, sid, query, { startDay, endDay, limit }) {
  const filters = ["self_id = ?", "user_id = ?", "is_empty = 0"]
  const params = [sid.self_id, sid.user_id]
  if (startDay) {
    filters.push("day >= ?")
    params.push(startDay)
  }
  if (endDay) {
    filters.push("day <= ?")
    params.push(endDay)
  }

  const q = String(query || "").trim()
  if (!q) {
    return database
      .prepare(`SELECT * FROM aigc_memory_day WHERE ${filters.join(" AND ")} ORDER BY day DESC LIMIT ?`)
      .all(...params, limit)
      .map(row => ({ row, rank: 0 }))
  }

  const terms = queryTerms(q)
  if (!terms.length) return []

  if (hasFts(database) && terms.every(term => term.length >= 3)) {
    try {
      const fFilters = filters.map(filter => `d.${filter}`)
      const rows = database
        .prepare(
          `SELECT d.*, bm25(aigc_memory_day_fts) AS rank
             FROM aigc_memory_day_fts
             JOIN aigc_memory_day d ON d.id = aigc_memory_day_fts.rowid
            WHERE aigc_memory_day_fts MATCH ? AND ${fFilters.join(" AND ")}
            ORDER BY rank
            LIMIT ?`,
        )
        .all(ftsQuery(terms), ...params, limit)
      // FTS 短语没命中时继续走 LIKE，覆盖“整句查询、总结里只有片段”的情况
      if (rows.length) return rows.map(row => ({ row, rank: -Number(row.rank) || 0 }))
    } catch (err) {
      log.warn(`每日记忆 FTS 查询失败，回退 LIKE: ${err.message}`)
    }
  }

  const likes = terms.map(() => "summary LIKE ? ESCAPE '\\'")
  return database
    .prepare(`SELECT * FROM aigc_memory_day WHERE ${filters.join(" AND ")} AND (${likes.join(" AND ")}) ORDER BY day DESC LIMIT ?`)
    .all(...params, ...terms.map(term => `%${escapeLike(term)}%`), limit)
    .map(row => {
      const summary = String(row.summary || "")
      const score = terms.reduce((sum, term) => sum + (summary.includes(term) ? 1 : 0), 0)
      return { row, rank: score }
    })
}

/** 向量检索；失败时返回空数组，由调用方回退关键词 */
async function vectorSearch(database, sid, query, { config, signal, startDay, endDay, limit, embed }) {
  let ec
  try {
    ec = resolveEmbeddingConfig(config)
  } catch (err) {
    log.warn(`每日记忆向量配置不可用，仅关键词检索: ${err.message}`)
    return []
  }
  if (!ec) return []
  if (!(await ensureVectorTable(database, ec))) return []
  // 没有可用向量时不必花一次 query embedding
  if (!database.prepare("SELECT 1 FROM aigc_memory_day WHERE self_id = ? AND user_id = ? AND is_empty = 0 AND vector_status = 1 LIMIT 1").get(sid.self_id, sid.user_id)) return []

  try {
    const [vector] = await embedTexts([query], { config, signal, taskType: "query", embedOverride: embed })
    validateVector(vector, ec)
    const k = Math.max(limit * 5, 20)
    const dayClauses = []
    const params = [JSON.stringify(vector), scopeOf(sid)]
    if (startDay) {
      dayClauses.push("AND day >= ?")
      params.push(startDay)
    }
    if (endDay) {
      dayClauses.push("AND day <= ?")
      params.push(endDay)
    }
    const hits = database.prepare(`SELECT memory_id, distance FROM aigc_memory_day_vec WHERE embedding MATCH ? AND k = ${k} AND scope = ? ${dayClauses.join(" ")} ORDER BY distance`).all(...params)
    if (!hits.length) return []

    const ids = hits.map(hit => Number(hit.memory_id))
    const marks = ids.map(() => "?").join(",")
    const rows = database.prepare(`SELECT * FROM aigc_memory_day WHERE id IN (${marks}) AND is_empty = 0`).all(...ids)
    const byId = new Map(rows.map(row => [Number(row.id), row]))
    const out = []
    for (const hit of hits) {
      const row = byId.get(Number(hit.memory_id))
      if (!row) continue
      if (startDay && row.day < startDay) continue
      if (endDay && row.day > endDay) continue
      const score = Math.max(-1, Math.min(1, 1 - Number(hit.distance)))
      if (ec.retrieval.minSimilarity > 0 && score < ec.retrieval.minSimilarity) continue
      out.push({ row, rank: score })
      if (out.length >= limit) break
    }
    return out
  } catch (err) {
    if (signal?.aborted) throw err
    log.warn(`每日记忆向量检索失败，回退关键词: ${err.message}`)
    return []
  }
}

function recencyFactor(day) {
  const days = Math.max(0, (Date.now() - dayStart(day)) / 86400000)
  return 0.7 + 0.3 * Math.exp(-days / 180)
}

function fuse(keywordRows, vectorRows, { limit, hasQuery }) {
  const merged = new Map()
  const ensure = row => {
    let item = merged.get(row.id)
    if (!item) {
      item = { row, kwRank: null, vecRank: null }
      merged.set(row.id, item)
    }
    return item
  }

  keywordRows.forEach(({ row }, index) => {
    ensure(row).kwRank = index
  })
  vectorRows.forEach(({ row }, index) => {
    ensure(row).vecRank = index
  })

  const list = [...merged.values()].map(item => {
    const rrf = (item.kwRank == null ? 0 : 1 / (RRF_K + item.kwRank + 1)) + (item.vecRank == null ? 0 : 1 / (RRF_K + item.vecRank + 1))
    const score = (hasQuery ? rrf : 0) * recencyFactor(item.row.day)
    return { ...rowOut(item.row), score }
  })

  return list.sort((a, b) => b.score - a.score || b.day.localeCompare(a.day)).slice(0, limit)
}

/** 记忆语义检索的重排模型（aigc.memory.rerank_model）；未选择模型时跳过 */
function resolveMemoryRerank(config) {
  const modelConfig = String(config?.aigc?.memory?.rerank_model || "").trim()
  if (!modelConfig) return null
  return { enable: true, modelConfig, topN: RERANK_TOP_N }
}

/** 对融合候选重排；未配置、返回空或失败时回退融合顺序 */
async function rerankMemories(query, rows, { config, signal }) {
  const rerank = resolveMemoryRerank(config)
  if (!rerank || !rows.length) return null
  try {
    const ranked = await rerankDocuments(
      query,
      rows.map(row => row.summary),
      { config, rerank, signal },
    )
    if (!ranked?.length) return null
    const out = []
    const used = new Set()
    for (const item of ranked) {
      if (!Number.isInteger(item.index) || item.index < 0 || item.index >= rows.length || used.has(item.index)) continue
      used.add(item.index)
      out.push({ ...rows[item.index], score: item.score })
    }
    for (let index = 0; index < rows.length; index++) if (!used.has(index)) out.push(rows[index])
    return out
  } catch (err) {
    if (signal?.aborted) throw err
    log.warn(`每日记忆重排失败，回退融合结果: ${err.message}`)
    return null
  }
}

/**
 * 检索每日总结；scope 始终限定当前用户，最多返回 5 条。
 * query 为空按时间（日期倒序）；有 query 走向量 + 关键词融合，配置重排模型时再重排。
 */
export async function searchSummaries(sid, query, { database, config = cfg, signal, startMs, endMs, embed } = {}) {
  const dbh = openDb(database)
  ensureSchema(dbh)
  const take = MAX_RESULTS
  const q = String(query || "").trim()
  const startDay = startMs != null ? dayKey(startMs) : null
  const endDay = endMs != null ? dayKey(endMs) : null
  const candidateLimit = take * CANDIDATE_FACTOR

  const keywordRows = keywordSearch(dbh, sid, q, { startDay, endDay, limit: candidateLimit })
  const vectorRows = q ? await vectorSearch(dbh, sid, q, { config, signal, startDay, endDay, limit: candidateLimit, embed }) : []
  const fused = fuse(keywordRows, vectorRows, { limit: candidateLimit, hasQuery: !!q })
  if (!q) return fused.slice(0, take)

  const reranked = await rerankMemories(q, fused, { config, signal })
  return (reranked || fused).slice(0, take)
}

/** 当前用户已有总结的时间跨度 */
export function span(sid, { database } = {}) {
  const dbh = openDb(database)
  ensureSchema(dbh)
  const row = dbh.prepare("SELECT MIN(day) AS first, MAX(day) AS last, COUNT(*) AS days FROM aigc_memory_day WHERE self_id = ? AND user_id = ? AND is_empty = 0").get(sid.self_id, sid.user_id)
  return row?.days ? row : null
}
