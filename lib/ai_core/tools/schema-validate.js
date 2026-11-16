/** 轻量 JSON Schema 校验 — 只覆盖工具参数常用关键字，未知关键字忽略，避免误判复杂 MCP schema */

const TYPE_CHECKS = {
  object: value => value !== null && typeof value === "object" && !Array.isArray(value),
  array: Array.isArray,
  string: value => typeof value === "string",
  number: value => typeof value === "number" && Number.isFinite(value),
  integer: value => Number.isInteger(value),
  boolean: value => typeof value === "boolean",
  null: value => value === null,
}

function typeName(value) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (Number.isInteger(value)) return "integer"
  return typeof value
}

function equal(a, b) {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** 未知类型不拦截，避免 MCP schema 使用的扩展关键字造成误判 */
function matchesType(value, type) {
  const check = TYPE_CHECKS[type]
  return check ? check(value) : true
}

/**
 * 校验参数，返回错误描述；合法时返回 null
 * @param {unknown} value
 * @param {object} schema
 * @param {string} path
 */
export function validateSchema(value, schema, path = "arguments") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null

  if (value === null && schema.nullable === true) return null

  if (schema.type) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).map(String)
    if (types.length && !types.some(type => matchesType(value, type))) {
      return `${path} 应为 ${types.join(" | ")}，实际为 ${typeName(value)}`
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(item => equal(item, value))) {
    return `${path} 必须是 ${schema.enum.map(item => JSON.stringify(item)).join(" / ")} 之一`
  }

  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) return `${path} 不能小于 ${schema.minimum}`
    if (schema.maximum != null && value > schema.maximum) return `${path} 不能大于 ${schema.maximum}`
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) return `${path} 必须大于 ${schema.exclusiveMinimum}`
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) return `${path} 必须小于 ${schema.exclusiveMaximum}`
  }

  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) return `${path} 长度不能小于 ${schema.minLength}`
    if (schema.maxLength != null && value.length > schema.maxLength) return `${path} 长度不能大于 ${schema.maxLength}`
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) return `${path} 不匹配 ${schema.pattern}`
      } catch {
        /* 非法 pattern 不拦截 */
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) return `${path} 至少需要 ${schema.minItems} 项`
    if (schema.maxItems != null && value.length > schema.maxItems) return `${path} 最多允许 ${schema.maxItems} 项`
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateSchema(value[i], schema.items, `${path}[${i}]`)
        if (err) return err
      }
    }
  } else if (value !== null && typeof value === "object") {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) return `${path}.${key} 是必填项`
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) {
          const err = validateSchema(value[key], sub, `${path}.${key}`)
          if (err) return err
        }
      }
    }
    // 组合 schema 可能通过 allOf/anyOf/$ref 声明属性，保守起见不在这里判额外字段
    const simpleObject = !schema.allOf && !schema.anyOf && !schema.oneOf && !schema.$ref && !schema.patternProperties
    if (schema.additionalProperties === false && simpleObject) {
      const allowed = new Set(Object.keys(schema.properties || {}))
      const extra = Object.keys(value).find(key => !allowed.has(key))
      if (extra) return `${path}.${extra} 不是允许的参数`
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      const err = validateSchema(value, sub, path)
      if (err) return err
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    if (!schema.anyOf.some(sub => !validateSchema(value, sub, path))) return `${path} 不满足 anyOf 约束`
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    if (!schema.oneOf.some(sub => !validateSchema(value, sub, path))) return `${path} 不满足 oneOf 约束`
  }

  return null
}
