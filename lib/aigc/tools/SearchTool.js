import tools from "./registry.js"
import { formatDate } from "../helpers/time.js"
import cfg from "../../config/config.js"

tools.register({
  name: "search",
  description: `搜索互联网：网页、图片、音乐或视频。需要实时信息或找媒体资源时使用。

搜索结果的使用方式:
- 搜网页: 用 browse 打开具体结果页面获取全文
- 搜图片: 取结果的 URL，用 send({ type:"image" }) 发送
- 搜音乐: 取结果的网易云 ID，用 send({ type:"music" }) 发送
- 搜视频: 取结果的 BVID，用 send({ type:"video" }) 发送`,
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "搜索关键词" },
      type: {
        type: "string",
        enum: ["web", "image", "music", "video"],
        description: "搜索类型: web=网页, image=图片, music=音乐, video=视频",
      },
      limit: { type: "number", description: "结果数量，默认 10" },
    },
    required: ["q", "type"],
  },
  execute: async args => {
    const { q, type, limit = 10 } = args

    if (type === "web" || type === "image") {
      try {
        const url = `http://localhost:8080/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`
        const res = await fetch(url)
        if (!res.ok) return `Search backend returned HTTP ${res.status}`
        const data = await res.json()

        if (type === "web") {
          const list = data.results || data.data?.results || data.data || []
          if (!list.length) return "No web results found"
          const items = list
            .slice(0, limit)
            .map((item, i) => `${i + 1}. [${item.title}](${item.url})\n   Summary: ${item.snippet || item.description || ""}\n   Source: ${item.source || ""}`)
            .join("\n\n")
          return `<search_results>\n[${formatDate(new Date(), "full")}, please judge the timeliness of search results]\n${items}\n</search_results>`
        }

        if (type === "image") {
          const list = data.images || data.data?.images || []
          if (!list.length) return "No images found"
          const items = list
            .slice(0, limit)
            .map((item, i) => `${i + 1}. Title: ${item.title}\n   URL: ${item.url}`)
            .join("\n\n")
          return `<image_results>\n${items}\n</image_results>`
        }
      } catch (err) {
        return `Search failed: ${err.message}`
      }
    }

    // 网易云音乐搜索
    if (type === "music") {
      try {
        const res = await fetch(`http://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&offset=0&total=true&limit=${limit}`)
        const json = await res.json()
        if (json.result?.songCount > 0) {
          const songs = json.result.songs.slice(0, limit)
          const items = songs.map((s, i) => `${i + 1}. Title: ${s.name}\n   ID: ${s.id}\n   Artist: ${s.artists.map(a => a.name).join("&")}\n   Alias: ${s.alias?.length ? s.alias.join(",") : "None"}`).join("\n\n")
          return `<music_results>\n${items}\n</music_results>`
        }
        return `No music found for: ${q}`
      } catch (err) {
        return `Music search failed: ${err.message}`
      }
    }

    // B站视频搜索
    if (type === "video") {
      try {
        const biliCookie = cfg.aigc?.bilibili_cookie || ""
        const headers = {
          accept: "*/*",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
          priority: "u=1, i",
          "sec-ch-ua": '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
          Referer: `https://search.bilibili.com/video?keyword=${encodeURIComponent(q)}`,
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
          cookie: biliCookie,
        }

        const apiParams = new URLSearchParams({
          search_type: "video",
          keyword: q,
          page: "1",
          page_size: String(limit),
          platform: "pc",
          source_tag: "3",
          web_location: "1430654",
        })
        const resp = await fetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${apiParams.toString()}`, { headers })
        const j = await resp.json()

        if (j.data?.numResults > 0) {
          const videos = j.data.result.slice(0, limit)
          const items = videos
            .map((r, i) => {
              const pubDate = r.pubdate ? formatDate(new Date(r.pubdate * 1000), "full") : "Unknown"
              return `${i + 1}. Title: ${r.title.replace(/<em class="keyword">/g, "").replace(/<\/em>/g, "")}\n   ID: ${r.bvid}\n   Author: ${r.author}\n   Plays: ${r.play}\n   Date: ${pubDate}`
            })
            .join("\n\n")
          return `<video_results>\n${items}\n</video_results>`
        }
        return `No video found for: ${q}`
      } catch (err) {
        return `Video search failed: ${err.message}`
      }
    }

    return `Unknown search type: ${type}`
  },
})
