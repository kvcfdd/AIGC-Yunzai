/** Redis 兼容层的表结构
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS redis_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redis_hash (
  key   TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (key, field)
);

CREATE TABLE IF NOT EXISTS redis_zset (
  key    TEXT NOT NULL,
  member TEXT NOT NULL,
  score  REAL NOT NULL,
  PRIMARY KEY (key, member)
);

CREATE INDEX IF NOT EXISTS redis_zset_rank ON redis_zset (key, score, member);

CREATE TABLE IF NOT EXISTS redis_expires (
  key        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS redis_expires_at ON redis_expires (expires_at);
`

/** 建表 */
export function initSchema(db) {
  db.exec(SCHEMA)
}
