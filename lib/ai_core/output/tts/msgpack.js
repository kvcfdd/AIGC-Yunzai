/** 最小 MessagePack 编码器 —— 覆盖 FishAudio TTS 请求所需的 nil/bool/int/float/str/bin/array/map */
export function encode(value) {
  const chunks = []
  write(value, chunks)
  return Buffer.concat(chunks)
}

function write(value, chunks) {
  if (value === null || value === undefined) {
    chunks.push(Buffer.from([0xc0]))
    return
  }
  if (typeof value === "boolean") {
    chunks.push(Buffer.from([value ? 0xc3 : 0xc2]))
    return
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) writeInt(value, chunks)
    else {
      const buf = Buffer.alloc(9)
      buf[0] = 0xcb
      buf.writeDoubleBE(value, 1)
      chunks.push(buf)
    }
    return
  }
  if (typeof value === "string") {
    writeString(value, chunks)
    return
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    writeBin(Buffer.from(value), chunks)
    return
  }
  if (Array.isArray(value)) {
    writeArray(value, chunks)
    return
  }
  if (typeof value === "object") {
    writeMap(value, chunks)
    return
  }
  throw new Error(`msgpack: 不支持的类型 ${typeof value}`)
}

function writeInt(n, chunks) {
  if (n >= 0 && n <= 0x7f) {
    chunks.push(Buffer.from([n]))
    return
  }
  if (n < 0 && n >= -32) {
    chunks.push(Buffer.from([0xe0 | (n + 32)]))
    return
  }
  const buf = Buffer.alloc(9)
  if (n >= 0) {
    if (n <= 0xff) {
      buf[0] = 0xcc
      buf.writeUInt8(n, 1)
      chunks.push(buf.subarray(0, 2))
    } else if (n <= 0xffff) {
      buf[0] = 0xcd
      buf.writeUInt16BE(n, 1)
      chunks.push(buf.subarray(0, 3))
    } else if (n <= 0xffffffff) {
      buf[0] = 0xce
      buf.writeUInt32BE(n, 1)
      chunks.push(buf.subarray(0, 5))
    } else {
      buf[0] = 0xcf
      buf.writeBigUInt64BE(BigInt(n), 1)
      chunks.push(buf)
    }
    return
  }
  if (n >= -128) {
    buf[0] = 0xd0
    buf.writeInt8(n, 1)
    chunks.push(buf.subarray(0, 2))
  } else if (n >= -32768) {
    buf[0] = 0xd1
    buf.writeInt16BE(n, 1)
    chunks.push(buf.subarray(0, 3))
  } else if (n >= -2147483648) {
    buf[0] = 0xd2
    buf.writeInt32BE(n, 1)
    chunks.push(buf.subarray(0, 5))
  } else {
    buf[0] = 0xd3
    buf.writeBigInt64BE(BigInt(n), 1)
    chunks.push(buf)
  }
}

function writeString(str, chunks) {
  const bytes = Buffer.from(str, "utf8")
  const len = bytes.length
  let head
  if (len <= 31) {
    head = Buffer.from([0xa0 | len])
  } else if (len <= 0xff) {
    head = Buffer.from([0xd9, len])
  } else if (len <= 0xffff) {
    head = Buffer.alloc(3)
    head[0] = 0xda
    head.writeUInt16BE(len, 1)
  } else {
    head = Buffer.alloc(5)
    head[0] = 0xdb
    head.writeUInt32BE(len, 1)
  }
  chunks.push(head, bytes)
}

function writeBin(bytes, chunks) {
  const len = bytes.length
  let head
  if (len <= 0xff) {
    head = Buffer.from([0xc4, len])
  } else if (len <= 0xffff) {
    head = Buffer.alloc(3)
    head[0] = 0xc5
    head.writeUInt16BE(len, 1)
  } else {
    head = Buffer.alloc(5)
    head[0] = 0xc6
    head.writeUInt32BE(len, 1)
  }
  chunks.push(head, bytes)
}

function writeArray(arr, chunks) {
  const len = arr.length
  if (len <= 15) {
    chunks.push(Buffer.from([0x90 | len]))
  } else {
    const head = Buffer.alloc(3)
    head[0] = 0xdc
    head.writeUInt16BE(len, 1)
    chunks.push(head)
  }
  for (const item of arr) write(item, chunks)
}

function writeMap(obj, chunks) {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined)
  const len = entries.length
  if (len <= 15) {
    chunks.push(Buffer.from([0x80 | len]))
  } else {
    const head = Buffer.alloc(3)
    head[0] = 0xde
    head.writeUInt16BE(len, 1)
    chunks.push(head)
  }
  for (const [key, value] of entries) {
    writeString(key, chunks)
    write(value, chunks)
  }
}
