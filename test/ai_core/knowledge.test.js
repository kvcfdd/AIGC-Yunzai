import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import Database from "better-sqlite3"
import { chunkDocument, markdownSections } from "../../lib/ai_core/knowledge/chunk.js"
import { buildQueryTerms, fuseCandidates, formatSearchResults, searchKnowledge } from "../../lib/ai_core/knowledge/retrieve.js"
import { resolveRerankConfig } from "../../lib/ai_core/knowledge/rerank.js"
import { parseFile } from "../../lib/ai_core/knowledge/parse.js"
import { resolveKnowledgeConfig } from "../../lib/ai_core/knowledge/config.js"
import { SystemPromptBuilder } from "../../lib/ai_core/perception/system-prompt.js"
import * as store from "../../lib/ai_core/knowledge/store.js"
import cfg from "../../lib/config/config.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }

// 配置模块会启动 chokidar 监听，测试结束后关闭以释放事件循环
test.after(() => {
  for (const watcher of Object.values(cfg.watcher || {})) watcher.close?.()
})

test("knowledge chunk: Markdown 按标题切分并跳过围栏代码块中的 #", () => {
  const text = ["# 安装", "## 配置", "```sh", "# 这不是标题", "```", "环境变量写在这里。", "## 部署", "使用 Node 启动服务。"].join("\n")
  const sections = markdownSections(text)
  assert.equal(sections.length, 2)
  assert.deepEqual(sections[0].headings, ["安装", "配置"])
  assert.match(sections[0].body, /# 这不是标题/)
  assert.deepEqual(sections[1].headings, ["安装", "部署"])

  const chunks = chunkDocument({ text, markdown: true, size: 200, overlap: 0 })
  assert.equal(chunks.length, 2)
  assert.match(chunks[0].content, /^安装 > 配置/)
  assert.match(chunks[1].content, /^安装 > 部署/)
})

test("knowledge chunk: 只有标题没有正文的章节合并进后续章节路径", () => {
  const chunks = chunkDocument({ text: "# A\n## B\n## C\n正文内容", markdown: true, size: 200, overlap: 0 })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].heading, "A > C")
})

test("knowledge chunk: 普通文本递归切分且不超过块长", () => {
  const text = "第一段。".repeat(80) + "\n\n" + "第二段。".repeat(80)
  const chunks = chunkDocument({ text, markdown: false, size: 120, overlap: 20 })
  assert.ok(chunks.length > 2)
  for (const chunk of chunks) assert.ok(chunk.content.length <= 120, `chunk too long: ${chunk.content.length}`)
})

test("knowledge query: 中文长句拆出 trigram 与短词", () => {
  const { trigrams, shortTerms } = buildQueryTerms("如何配置环境变量")
  assert.ok(trigrams.includes("配置环"))
  assert.ok(shortTerms.includes("配置"))
  assert.ok(!shortTerms.includes("如何"))
})

test("knowledge fuse: 稠密全局归一化、稀疏按库归一化", () => {
  const fused = fuseCandidates({
    dense: [
      { chunkId: 1, kbId: "a", score: 0.9 },
      { chunkId: 2, kbId: "a", score: 0.5 },
    ],
    fts: [
      { chunkId: 2, kbId: "a", score: 5 },
      { chunkId: 3, kbId: "b", score: 1 },
    ],
    like: [{ chunkId: 2, kbId: "a", score: 2 }],
    denseWeight: 0.9,
  })
  assert.equal(fused[0].chunkId, 1)
  assert.ok(fused.some(item => item.chunkId === 3))
  // 同分时由 RRF 稳定排序：chunk2 同时命中稠密与稀疏，排在仅稀疏的 chunk3 前面
  assert.ok(fused.find(item => item.chunkId === 2).rrf > fused.find(item => item.chunkId === 3).rrf)
})

test("knowledge fuse: 仅稀疏时权重自动归一为 1", () => {
  const fused = fuseCandidates({
    dense: [],
    fts: [{ chunkId: 1, kbId: "a", score: 3 }],
    like: [],
    denseWeight: 0.9,
  })
  assert.equal(fused[0].score, 1)
})

test("knowledge config: 默认值与范围钳制", () => {
  const def = resolveKnowledgeConfig({})
  assert.equal(def.chunkSize, 512)
  assert.equal(def.topMFinal, 5)
  assert.equal(def.mode, "tool")
  assert.equal(def.rerank.enable, false)
  assert.equal(def.rerank.modelConfig, "")
  assert.equal(resolveKnowledgeConfig({ aigc: { knowledge: { retrieval_mode: "auto" } } }).mode, "auto")
  assert.equal(resolveKnowledgeConfig({ aigc: { knowledge: { retrieval_mode: "nope" } } }).mode, "tool")

  const clamped = resolveKnowledgeConfig({ aigc: { knowledge: { chunk_size: 10, chunk_overlap: 9999, dense_weight: 2, top_m_final: 99 } } })
  assert.equal(clamped.chunkSize, 100)
  assert.equal(clamped.chunkOverlap, 99)
  assert.equal(clamped.denseWeight, 1)
  assert.equal(clamped.topMFinal, 20)
})

test("knowledge auto: 仅主对话自动检索", async () => {
  const config = { aigc: { knowledge: { enable: true, retrieval_mode: "auto" } } }
  const injected = new SystemPromptBuilder({ event: { _injected: true }, skills: null, config })
  injected.setKnowledgeQuery("测试")
  assert.equal(await injected._buildKnowledgeContext(false), "")

  const ambient = new SystemPromptBuilder({ event: {}, skills: null, config })
  ambient.setKnowledgeQuery("测试")
  assert.equal(await ambient._buildKnowledgeContext(true), "")

  const disabled = new SystemPromptBuilder({ event: {}, skills: null, config: { aigc: { knowledge: { enable: false, retrieval_mode: "auto" } } } })
  disabled.setKnowledgeQuery("测试")
  assert.equal(await disabled._buildKnowledgeContext(false), "")

  const toolMode = new SystemPromptBuilder({ event: {}, skills: null, config: { aigc: { knowledge: { enable: true, retrieval_mode: "tool" } } } })
  toolMode.setKnowledgeQuery("测试")
  assert.equal(await toolMode._buildKnowledgeContext(false), "")
})

test("knowledge rerank config: 连接参数来自 models 中选中的重排条目", () => {
  const base = {
    aigc: {
      models: [
        { name: "chat", base_url: "https://chat.example", model: "chat-model" },
        {
          name: "rr",
          base_url: "https://rerank.example/v1",
          api_keys: ["k1", "k2"],
          model: "bge-reranker-v2",
          proxy: true,
          timeout_ms: 5000,
          retry_count: 2,
          headers: { "X-Test": "1" },
          extra_body: { return_documents: false },
        },
      ],
      knowledge: { rerank: { enable: true, model_config: "rr", top_n: 7 } },
    },
  }

  const rc = resolveRerankConfig(base)
  assert.equal(rc.model, "bge-reranker-v2")
  assert.equal(rc.baseUrl, "https://rerank.example/v1")
  assert.deepEqual(rc.apiKeys, ["k1", "k2"])
  assert.equal(rc.proxy, true)
  assert.equal(rc.timeoutMs, 5000)
  assert.equal(rc.retryCount, 2)
  assert.deepEqual(rc.headers, { "X-Test": "1" })
  assert.deepEqual(rc.extraBody, { return_documents: false })
  assert.equal(rc.topN, 7)

  assert.equal(resolveRerankConfig({ aigc: { knowledge: { rerank: { enable: false, model_config: "rr" } } } }), null)
  assert.equal(resolveRerankConfig({ aigc: { knowledge: { rerank: { enable: true, model_config: "" } } } }), null)
  assert.equal(resolveRerankConfig({ aigc: { models: [{ name: "rr", model: "m" }], knowledge: { rerank: { enable: true, model_config: "rr" } } } }), null)
})

test("knowledge parse: Markdown 文件保留标题并标记结构化", async () => {
  const parsed = await parseFile({ name: "手册.md", buffer: Buffer.from("# 标题\n\n正文") })
  assert.equal(parsed.title, "手册")
  assert.equal(parsed.markdown, true)
  assert.match(parsed.text, /正文/)
})

test("knowledge parse: PDF 明确拒绝", async () => {
  await assert.rejects(() => parseFile({ name: "a.pdf", buffer: Buffer.from("%PDF") }), /暂不支持 PDF/)
})

test("knowledge store: 文档写入、FTS/LIKE 检索与删除", () => {
  const db = new Database(":memory:")
  store.ensureSchema(db)
  assert.equal(store.hasFts(db), true)

  const kb = store.createKb(db, { name: "测试库", description: "说明" })
  const doc = { id: "doc1", kb_id: kb.id, name: "手册", source_type: "file", source: "a.md", mime: "text/markdown", size: 10, chunk_count: 2, vector_count: 0, created_at: Date.now() }
  store.insertDocument(db, doc, [
    { heading: "安装 > 配置", content: "安装 > 配置\n\n环境变量需要配置 API Key" },
    { heading: "部署", content: "部署\n\n使用 Node 启动服务" },
  ])

  const kbs = store.listKbs(db)
  assert.equal(kbs.length, 1)
  assert.equal(kbs[0].doc_count, 1)
  assert.equal(kbs[0].chunk_count, 2)

  const fts = store.searchFts(db, [kb.id], ["环境变量"], 10)
  assert.equal(fts.length, 1)
  assert.ok(fts[0].score > 0)

  const like = store.searchLike(db, [kb.id], ["部署"], 10)
  assert.equal(like.length, 1)
  // LIKE 对 ASCII 不区分大小写，计分也保持一致
  const mixedCase = store.searchLike(db, [kb.id], ["NODE"], 10)
  assert.equal(mixedCase.length, 1)
  assert.equal(mixedCase[0].score, 1)

  assert.equal(store.deleteDocument(db, kb.id, "doc1"), 1)
  assert.equal(store.listDocuments(db, kb.id).length, 0)
  assert.equal(store.searchFts(db, [kb.id], ["环境变量"], 10).length, 0)

  store.deleteKb(db, kb.id)
  assert.equal(store.listKbs(db).length, 0)
  db.close()
})

test("knowledge store: sqlite-vec 向量写入、检索与模型变更清理", async () => {
  const db = new Database(":memory:")
  store.ensureSchema(db)
  const ec = { adapterName: "test", embeddingModel: "m", dimensions: 3 }
  assert.equal(await store.ensureVectorTable(db, ec), true)

  const kb = store.createKb(db, { name: "向量库" })
  const doc = { id: "doc3", kb_id: kb.id, name: "水果", source_type: "file", source: "c.md", mime: "text/markdown", size: 10, chunk_count: 2, vector_count: 2, created_at: Date.now() }
  store.insertDocument(
    db,
    doc,
    [
      { heading: "", content: "苹果" },
      { heading: "", content: "香蕉" },
    ],
    [
      [1, 0, 0],
      [0, 1, 0],
    ],
  )

  const hits = store.searchVectors(db, kb.id, [0.9, 0.1, 0], 2)
  assert.equal(hits.length, 2)
  assert.ok(hits[0].score > hits[1].score)

  // 模型签名变化：旧向量清空，文档块与 FTS 保留
  await store.ensureVectorTable(db, { adapterName: "test", embeddingModel: "m2", dimensions: 3 })
  assert.equal(store.searchVectors(db, kb.id, [0.9, 0.1, 0], 2).length, 0)
  assert.equal(store.listDocuments(db, kb.id)[0].vector_count, 0)
  assert.equal(store.countChunks(db, kb.id), 2)
  db.close()
})

test("knowledge rerank: 通用 /rerank 接口重排结果", async () => {
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", chunk => (body += chunk))
    req.on("end", () => {
      const data = JSON.parse(body)
      assert.equal(data.model, "rerank-test")
      assert.ok(Array.isArray(data.documents) && data.documents.length === 2)
      res.setHeader("Content-Type", "application/json")
      res.end(
        JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.99 },
            { index: 0, relevance_score: 0.4 },
          ],
        }),
      )
    })
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port

  const db = new Database(":memory:")
  store.ensureSchema(db)
  const kb = store.createKb(db, { name: "重排库" })
  const doc = { id: "doc4", kb_id: kb.id, name: "水果", source_type: "file", source: "d.md", mime: "text/markdown", size: 10, chunk_count: 2, vector_count: 0, created_at: Date.now() }
  store.insertDocument(db, doc, [
    { heading: "", content: "苹果 香蕉" },
    { heading: "", content: "苹果 橙子" },
  ])

  const config = {
    aigc: {
      models: [{ name: "rerank-test", base_url: `http://127.0.0.1:${port}`, api_keys: "", model: "rerank-test" }],
      embeddings: { enable: false },
      knowledge: { rerank: { enable: true, model_config: "rerank-test", top_n: 2 } },
    },
  }
  const results = await searchKnowledge("苹果", { config, database: db })
  assert.equal(results.length, 2)
  assert.equal(results[0].content, "苹果 橙子")
  assert.equal(results[0].score, 0.99)
  server.close()
  db.close()
})

test("knowledge search: 无向量时走关键词混合检索并格式化", async () => {
  const db = new Database(":memory:")
  store.ensureSchema(db)
  const kb = store.createKb(db, { name: "产品手册" })
  const doc = { id: "doc2", kb_id: kb.id, name: "部署说明", source_type: "file", source: "b.md", mime: "text/markdown", size: 10, chunk_count: 1, vector_count: 0, created_at: Date.now() }
  store.insertDocument(db, doc, [{ heading: "配置", content: "配置\n\n环境变量需要配置 API Key 和代理地址" }])

  const config = { aigc: { embeddings: { enable: false }, knowledge: {} } }
  const results = await searchKnowledge("环境变量怎么配置", { config, database: db })
  assert.ok(results.length >= 1)
  assert.equal(results[0].kb_name, "产品手册")
  assert.equal(results[0].doc_name, "部署说明")

  const text = formatSearchResults(results)
  assert.match(text, /<knowledge_search>/)
  assert.match(text, /产品手册 \/ 部署说明/)
  const autoText = formatSearchResults(results, { tag: "knowledge_context" })
  assert.match(autoText, /^<knowledge_context>/)
  assert.match(autoText, /<\/knowledge_context>$/)
  assert.doesNotMatch(autoText, /<knowledge_search>/)
  db.close()
})
