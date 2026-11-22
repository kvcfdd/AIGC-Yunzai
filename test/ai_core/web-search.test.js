import test from "node:test"
import assert from "node:assert/strict"
import { parseSearchArgs, mergeSearchResults, formatSearchOutput, resolveSearchOptions, collectKeys, searchWithKeys } from "../../lib/ai_core/tools/builtin/WebSearchTool.js"

test("web_search: queries 校验与去重", () => {
  assert.deepEqual(parseSearchArgs({ queries: [" a ", "b", "a"] }), ["a", "b"])
  assert.throws(() => parseSearchArgs({ queries: [] }), /at least one query/)
  assert.throws(() => parseSearchArgs({ queries: ["a", "b", "c", "d", "e"] }), /at most 4 queries/)
  assert.throws(() => parseSearchArgs({ queries: ["a", "  "] }), /non-empty string/)
})

test("web_search: 多查询按排名轮询并去重", () => {
  const a = [{ url: "u1" }, { url: "u2" }, { url: "u3" }]
  const b = [{ url: "u2" }, { url: "u4" }]
  assert.deepEqual(
    mergeSearchResults([a, b], 4).map(item => item.url),
    ["u1", "u2", "u4", "u3"],
  )
})

test("web_search: keys 解析", () => {
  assert.deepEqual(collectKeys(" a, b ,, c "), ["a", "b", "c"])
  assert.deepEqual(collectKeys(["a", " b "]), ["a", "b"])
  assert.deepEqual(collectKeys(undefined), [])
})

test("web_search: 搜索源与参数解析", () => {
  const options = resolveSearchOptions({ config: { aigc: { search: { provider: "anysearch", max_results: 5, retry_count: 5, keys: "k1, k2" } } } })
  assert.equal(options.name, "anysearch")
  assert.equal(options.maxResults, 8, "返回条数内置")
  assert.deepEqual(options.keys, ["k1", "k2"])
  assert.equal(options.attempts, 3, "重试次数内置")
  assert.equal(resolveSearchOptions({}).name, "anysearch", "缺省使用 anysearch")
  assert.throws(() => resolveSearchOptions({ config: { aigc: { search: { provider: "unknown" } } } }), /未知搜索源/)
  assert.throws(() => resolveSearchOptions({ config: { aigc: { search: { provider: "tavily" } } } }), /aigc\.search\.keys/)
})

test("web_search: deepseek 请求与结果映射", async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ results: [{ title: "T", url: "https://a.com", snippet: "short", summary: "long summary" }, { title: "skip" }] }), { status: 200 })
  }
  try {
    const options = resolveSearchOptions({ config: { aigc: { search: { provider: "deepseek", keys: "k1", max_results: 5 } } } })
    const rows = await options.provider.search("测试查询", { key: "k1", maxResults: 5 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search")
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].init.headers.Authorization, "Bearer k1")
    assert.deepEqual(JSON.parse(calls[0].init.body), { query: "测试查询", count: 5, need_content: false })
    assert.deepEqual(rows, [{ title: "T", url: "https://a.com", snippet: "long summary" }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("web_search: 可重试错误按圈切换 Key，其它 4xx 直接抛出", async () => {
  const calls = []
  let failed = false
  const provider = {
    label: "T",
    async search(query, { key }) {
      calls.push(key)
      if (!failed) {
        failed = true
        const err = new Error("HTTP 429")
        err.status = 429
        throw err
      }
      return [{ title: "T", url: "https://a.com", snippet: "s" }]
    },
  }
  const rows = await searchWithKeys(provider, "q", { keys: ["k1", "k2"], attempts: 3 })
  assert.equal(rows.length, 1)
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0], calls[1])

  let badCalls = 0
  const bad = {
    label: "B",
    async search() {
      badCalls++
      const err = new Error("HTTP 400")
      err.status = 400
      throw err
    },
  }
  await assert.rejects(searchWithKeys(bad, "q", { keys: ["k1", "k2"], attempts: 3 }), /HTTP 400/)
  assert.equal(badCalls, 1)
})

test("web_search: Sources 输出", () => {
  const text = formatSearchOutput([{ title: "T", url: "https://a.com", snippet: " hello   world " }])
  assert.match(text, /external web data/)
  assert.match(text, /Sources:\n- \[T\]\(https:\/\/a\.com\) — hello world/)
  assert.match(text, /Cite the relevant URLs/)

  assert.match(formatSearchOutput([]), /No results found\./)
})
