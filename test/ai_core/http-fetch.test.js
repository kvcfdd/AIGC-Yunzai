import test from "node:test"
import assert from "node:assert/strict"

globalThis.logger = new Proxy(function () {}, { get: () => () => {}, apply: () => {} })

const { htmlToMarkdown, extractTitle } = await import("../../lib/ai_core/helpers/http-fetch.js")

test("http-fetch: 提取 title", () => {
  assert.equal(extractTitle("<html><head><title> Hi &amp; Bye </title></head></html>"), "Hi & Bye")
})

test("http-fetch: HTML 转 Markdown 并移除脚本/隐藏内容", () => {
  const md = htmlToMarkdown(
    `<html><head><title>T</title><style>x{}</style></head><body>
      <h1>Hi</h1><p>Hello <b>world</b></p>
      <script>alert(1)</script>
      <div style="display:none">hidden</div>
      <div aria-hidden="true">aria</div>
    </body></html>`,
  )
  assert.match(md, /# Hi/)
  assert.match(md, /Hello \*\*world\*\*/)
  assert.doesNotMatch(md, /alert\(1\)|hidden|aria/)
  assert.doesNotMatch(md, /^T$/m)
})
