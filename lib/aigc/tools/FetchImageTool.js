import tools from "./registry.js";
import { imageToDataUri } from "../provider.js";
import log from "../helpers/log.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0";

tools.register({
  name: "fetch_image",
  description:
    "Download and view an image from a URL. Use when you need to see what an image looks like — for example, a user's avatar, a photo they mention, or any image URL you encounter.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "Image URL to fetch and view. Supports http/https URLs and data URIs.",
      },
      referer: {
        type: "string",
        description:
          "Referer from the search result (image search returns 'Referer' field). REQUIRED for most image CDNs — without it the download will fail.",
      },
    },
    required: ["url"],
  },
  execute: async (args, ctx) => {
    const { url, referer } = args;
    if (!url) return "No URL provided";

    // 已经是 data URI，直接返回
    if (url.startsWith("data:image/")) {
      return { images: [url], text: "图片获取成功" };
    }

    const headers = {
      "User-Agent": UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "max-age=0",
      Priority: "u=0, i",
      "Sec-Ch-Ua":
        '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site",
    };

    if (referer) {
      try {
        const u = new URL(
          referer.startsWith("http") ? referer : `https://${referer}`,
        );
        headers.Referer = u.href;
      } catch {
        /* pass */
      }
    }

    try {
      const dataUri = await imageToDataUri(url, headers);
      return { images: [dataUri], text: "图片获取成功" };
    } catch (err) {
      log.debug(`fetch_image 失败: ${err.message}`);
      return `获取图片失败: ${err.message}${referer ? "" : "（系统提示：如果图片来自搜索结果，可尝试传入 Referer 参数重试）"}`;
    }
  },
});
