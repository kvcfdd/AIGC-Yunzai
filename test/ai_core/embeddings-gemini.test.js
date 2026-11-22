import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import gemini from "../../lib/ai_core/embeddings/gemini.js"

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

function readBody(req) {
  return new Promise(resolve => {
    let body = ""
    req.on("data", chunk => (body += chunk))
    req.on("end", () => resolve(body))
  })
}

test("gemini embedding: batchEmbedContents 裸请求与归一化", async t => {
  let seen
  const server = await startServer(async (req, res) => {
    seen = { url: req.url, key: req.headers["x-goog-api-key"], body: JSON.parse(await readBody(req)) }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ embeddings: [{ values: [3, 4] }, { values: [0, 0] }] }))
  })
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })

  const config = { base_url: `http://127.0.0.1:${server.address().port}`, embeddingModel: "gemini-embedding-001", dimensions: 768, headers: {}, extra_body: {} }
  const vectors = await gemini.embed(["a", "b"], { config, apiKey: "k", taskType: "document", timeoutMs: 5000 })

  assert.equal(seen.url, "/v1beta/models/gemini-embedding-001:batchEmbedContents")
  assert.equal(seen.key, "k")
  assert.equal(seen.body.requests.length, 2)
  assert.deepEqual(
    seen.body.requests.map(r => r.content.parts[0].text),
    ["a", "b"],
  )
  assert.equal(seen.body.requests[0].model, "models/gemini-embedding-001")
  assert.equal(seen.body.requests[0].taskType, "RETRIEVAL_DOCUMENT")
  assert.equal(seen.body.requests[0].outputDimensionality, 768)
  assert.deepEqual(vectors, [
    [0.6, 0.8],
    [0, 0],
  ])
})

test("gemini embedding: embedding-2 使用文本前缀且不带 taskType", async t => {
  let seen
  const server = await startServer(async (req, res) => {
    seen = JSON.parse(await readBody(req))
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ embeddings: [{ values: [1, 0] }] }))
  })
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })

  const config = { base_url: `http://127.0.0.1:${server.address().port}`, embeddingModel: "gemini-embedding-2", dimensions: 64, headers: {}, extra_body: {} }
  await gemini.embed(["hello"], { config, apiKey: "k", taskType: "query", timeoutMs: 5000 })

  assert.equal(seen.requests[0].content.parts[0].text, "task: search result | query: hello")
  assert.equal(seen.requests[0].taskType, undefined)
  assert.equal(seen.requests[0].outputDimensionality, 64)
})

test("gemini embedding: 429 保留状态码和配额原因", async t => {
  const server = await startServer((req, res) => {
    res.writeHead(429, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { code: 429, message: "Quota exceeded for embedding", status: "RESOURCE_EXHAUSTED", details: [{ metadata: { quota_limit_value: "0", quota_location: "us-south1" } }] } }))
  })
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })

  const config = { base_url: `http://127.0.0.1:${server.address().port}`, embeddingModel: "gemini-embedding-001", dimensions: 768, headers: {}, extra_body: {} }
  await assert.rejects(gemini.embed(["a"], { config, apiKey: "k", taskType: "document", timeoutMs: 5000 }), err => {
    assert.equal(err.status, 429)
    assert.match(err.message, /Quota exceeded for embedding/)
    assert.match(err.message, /limit=0/)
    assert.match(err.message, /region=us-south1/)
    return true
  })
})
