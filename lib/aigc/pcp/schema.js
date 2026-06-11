/**
 * PCP 参数简化格式 → OpenAI Function Calling JSON Schema 转换器
 *
 * 插件方写:
 *   params: {
 *     target:  { type: "number", desc: "目标QQ" },
 *     reason:  { type: "string", desc: "理由", optional: true },
 *     ids:     { type: "array", items: "number", desc: "批量QQ" },
 *     scope:   { type: "string", desc: "范围", enum: ["global","user","group"] },
 *   }
 *
 * 自动展开为:
 *   {
 *     type: "object",
 *     properties: {
 *       target: { type: "number", description: "目标QQ" },
 *       ...
 *     },
 *     required: ["target"]
 *   }
 */

/** 展开简化 params 为 JSON Schema */
export function expandParams(params) {
  if (!params || typeof params !== "object") {
    return { type: "object", properties: {} }
  }

  const properties = {}
  const required = []

  for (const [key, def] of Object.entries(params)) {
    if (!def || typeof def !== "object") continue

    const prop = {}

    // type 映射
    if (def.type) {
      prop.type = def.type
      if (def.type === "array" && def.items) {
        prop.items = typeof def.items === "string" ? { type: def.items } : def.items
      }
      if (def.type === "object" && def.properties) {
        const nested = expandParams(def.properties)
        prop.properties = nested.properties
      }
    }

    // description
    if (def.desc) prop.description = def.desc

    // enum
    if (Array.isArray(def.enum)) prop.enum = def.enum

    // default
    if (def.default !== undefined) prop.default = def.default

    properties[key] = prop

    // 没标 optional 且没标 required:false → 入 required
    if (!def.optional && def.required !== false) {
      required.push(key)
    }
  }

  const schema = { type: "object", properties }
  if (required.length) schema.required = required
  return schema
}
