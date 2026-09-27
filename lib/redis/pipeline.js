/** 管道 —— 经 Object.assign 挂到 RedisClient 原型
 */
export default {
  multi() {
    const client = this
    const queue = []
    const pipe = {}

    for (const name of client._commandNames().filter(n => n !== "multi")) {
      const enqueue = (...args) => {
        queue.push([name, args])
        return pipe
      }
      pipe[name] = enqueue
      const upper = name.toUpperCase()
      if (upper !== name) pipe[upper] = enqueue
    }

    pipe.exec = () => {
      try {
        const db = client._getDb()
        return Promise.resolve(db.transaction(() => queue.map(([name, args]) => client[name](...args)))())
      } catch (err) {
        return Promise.reject(err)
      }
    }

    return pipe
  },
}
