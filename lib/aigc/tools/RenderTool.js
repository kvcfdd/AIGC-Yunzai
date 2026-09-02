import tools from "./registry.js"
import browser from "../../renderer/browser.js"
import log from "../helpers/log.js"
import { marked } from "marked"

function stripDocument(raw) {
  let s = raw
  s = s.replace(/<!DOCTYPE[^>]*>/gi, "")
  s = s.replace(/<\/?html[^>]*>/gi, "")
  s = s.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
  s = s.replace(/<\/?body[^>]*>/gi, "")
  return s.trim()
}

const TPL = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }

  html, body {
    width: 1080px;
    min-width: 1080px;
    max-width: 1080px;
    margin: 0;
    padding: 0;
    background: #ffffff;
    overflow: hidden;
    font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    font-size: 18px;
    line-height: 1.75;
    color: #1f2937;
    word-wrap: break-word;
  }

  .paper {
    width: 1080px;
    min-width: 1080px;
    max-width: 1080px;
    padding: 56px 68px;
    background: #ffffff;
  }

  .paper h1, .paper h2, .paper h3, .paper h4, .paper h5, .paper h6 {
    font-weight: 700;
    line-height: 1.35;
    margin: 1.5em 0 .45em;
    color: #0f172a;
  }
  .paper h1:first-child,
  .paper h2:first-child,
  .paper h3:first-child,
  .paper h4:first-child { margin-top: 0; }

  .paper h1 { font-size: 1.75em; border-bottom: 2px solid #e5e7eb; padding-bottom: .3em; }
  .paper h2 { font-size: 1.4em; border-bottom: 1.5px solid #e5e7eb; padding-bottom: .25em; }
  .paper h3 { font-size: 1.15em; }
  .paper h4 { font-size: 1em; color: #334155; }

  .paper p { margin: .75em 0; }
  .paper p:first-child { margin-top: 0; }
  .paper strong { font-weight: 700; color: #0f172a; }
  .paper a { color: #2563eb; text-decoration: underline; }

  .paper :not(pre) > code {
    background: #f1f5f9;
    color: #be123c;
    padding: 2px 8px;
    border-radius: 4px;
    font-family: "Cascadia Code", "Fira Code", "SF Mono", Consolas, "Courier New", monospace;
    font-size: .85em;
  }

  .paper pre {
    width: 100%;
    background: #0d1117;
    color: #e6edf3;
    padding: 22px 26px;
    border-radius: 10px;
    margin: 1em 0;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .paper pre code {
    font-family: "Cascadia Code", "Fira Code", "SF Mono", Consolas, "Courier New", monospace;
    font-size: .85em;
    background: none !important;
    color: inherit !important;
    padding: 0 !important;
    border-radius: 0 !important;
  }

  .paper blockquote {
    margin: 1em 0;
    padding: 14px 22px;
    border-left: 4px solid #3b82f6;
    background: #f0f7ff;
    border-radius: 0 8px 8px 0;
    color: #475569;
  }
  .paper blockquote p { margin: .4em 0; }
  .paper blockquote p:first-child { margin-top: 0; }

  .paper table {
    width: 100%;
    border-collapse: collapse;
    margin: 1em 0;
    font-size: .9em;
  }
  .paper thead { border-bottom: 2px solid #d1d5db; }
  .paper th {
    padding: 10px 14px;
    text-align: left;
    font-weight: 600;
    color: #374151;
    background: #f9fafb;
    white-space: nowrap;
  }
  .paper td {
    padding: 9px 14px;
    border-bottom: 1px solid #f3f4f6;
  }

  .paper ul, .paper ol { margin: .6em 0; padding-left: 1.5em; }
  .paper li { margin: .25em 0; }
  .paper ul { list-style-type: disc; }
  .paper ul ul { list-style-type: circle; }
  .paper ol { list-style-type: decimal; }

  .paper hr { border: none; border-top: 1.5px solid #e5e7eb; margin: 1.8em 0; }

  .paper img {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 8px;
    margin: .75em 0;
  }

  .paper video {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 8px;
    margin: .75em 0;
  }
</style>
</head>
<body>
<div id="render-target" class="paper">__CONTENT__</div>
</body>
</html>`

tools.register({
  name: "render",
  description: `将 Markdown/HTML 渲染为精美图片 (1080px 宽 PNG)。适合:
- 需要排版格式的结果 (表格、代码高亮、分级标题)
- 长文本回复会刷屏时
- 搜索结果汇总、数据报告

提示: 不需要格式的简短回复直接输出文本即可,不要没事就渲染图片。

示例:
- 渲染 Markdown: render({ content: "# 今日新闻\n\n1. 第一条\n2. 第二条" })
- 渲染 HTML 表格: render({ content: "<table><tr><th>名称</th><th>数值</th></tr>...</table>" })`,
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Markdown 或 HTML 源码,无需指定宽高,工具自动处理排版。",
      },
    },
    required: ["content"],
  },
  execute: async (args, ctx) => {
    const realEvent = ctx?.event
    if (!realEvent) return "Cannot get user context"

    let rawContent = args.content
    const isRawHtml = /^\s*</.test(rawContent)

    if (isRawHtml) {
      rawContent = stripDocument(rawContent)
    } else {
      try {
        rawContent = marked.parse(rawContent, { breaks: true })
      } catch (err) {
        log.error(`Markdown 解析失败: ${err.message}`)
        return `Markdown parsing failed: ${err.message}`
      }
    }

    const html = TPL.split("__CONTENT__").join(rawContent)

    // 进入浏览器任务
    return browser.runTask(async () => {
      let context = null
      try {
        const chromium = await browser.getBrowser()

        context = await chromium.newContext({
          viewport: { width: 1080, height: 720 },
          deviceScaleFactor: 2,
        })

        const page = await context.newPage()
        await page.setContent(html, { waitUntil: "domcontentloaded" })

        // HTML 模式: 透明底 + 容器自适应 1080px
        if (isRawHtml) {
          await page.addStyleTag({
            content: "html, body, #render-target { background: transparent !important; padding: 0 !important; }",
          })
          const target = page.locator("#render-target")
          if ((await target.locator(":scope > :not(style, script)").count()) === 1) {
            const contentEl = target.locator(":scope > :not(style, script)").first()
            const childBox = await contentEl.boundingBox()
            if (childBox && childBox.width > 0 && childBox.width !== 1080) {
              const scale = Math.min(1080 / childBox.width, 4)
              await contentEl.evaluate((el, s) => {
                el.style.zoom = s
              }, scale)
            }
          }
        }

        // 等待字体与图片就绪
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(async () => {
          await Promise.all(
            [...document.images].map(async img => {
              if (img.complete && img.naturalWidth > 0) return
              try {
                await Promise.race([img.decode().catch(() => {}), new Promise(r => setTimeout(r, 3000))])
              } catch {}
            }),
          )
        })

        // 高度自适应内容
        const bodyBox = await page.locator("body").boundingBox()
        const viewH = bodyBox ? Math.ceil(bodyBox.height) : 720
        await page.setViewportSize({ width: 1080, height: viewH })

        const imgBuf = await page.screenshot({
          type: "png",
          omitBackground: isRawHtml,
        })

        realEvent.reply(segment.image(imgBuf))
        return "[Rendered and sent to user — reply in text if needed]"
      } catch (err) {
        log.error(`render 失败: ${err.message}`)
        return `Render failed: ${err.message}`
      } finally {
        if (context) await context.close().catch(() => {})
      }
    })
  },
})
