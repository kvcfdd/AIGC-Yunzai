import { fetchJSON, saveAudio, wavFromPcm } from "../util.js"

/** Gemini TTS —— generateContent + AUDIO modality，返回 24kHz/16bit/单声道 PCM */
export default {
  label: "Gemini TTS",
  defaults: {
    base_url: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-flash-preview-tts",
    voice: "Leda",
    prefix: "",
    timeout_ms: 20_000,
  },
  ready: opts => !!opts.api_key,
  async tts(text, opts) {
    const base = String(opts.base_url || "https://generativelanguage.googleapis.com").replace(/\/+$/, "")
    const apiBase = /\/v1beta$/.test(base) ? base : `${base}/v1beta`
    const prompt = opts.prefix ? `${opts.prefix}: ${text}` : text

    const data = await fetchJSON(`${apiBase}/models/${encodeURIComponent(opts.model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": opts.api_key,
      },
      body: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } },
          },
        },
      },
      timeoutMs: opts.timeout_ms,
    })

    const part = data?.candidates?.[0]?.content?.parts?.find?.(p => p?.inlineData?.data || p?.inline_data?.data)
    const b64 = part?.inlineData?.data || part?.inline_data?.data
    if (!b64) throw new Error(`Gemini TTS 未返回音频${data?.error?.message ? `: ${data.error.message}` : ""}`)
    return saveAudio(wavFromPcm(Buffer.from(b64, "base64")), "wav")
  },
}
