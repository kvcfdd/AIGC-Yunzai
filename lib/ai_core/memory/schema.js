/** 对话上下文表结构
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS aigc_message (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  self_id    TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  turn       INTEGER NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content    TEXT,
  created_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS aigc_message_user_turn ON aigc_message (self_id, user_id, turn);

CREATE TABLE IF NOT EXISTS aigc_context (
  self_id TEXT    NOT NULL,
  user_id TEXT    NOT NULL,
  turn    INTEGER NOT NULL,
  seq     INTEGER NOT NULL,
  role    TEXT    NOT NULL,
  content TEXT,
  payload TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (self_id, user_id, turn, seq)
);

CREATE INDEX IF NOT EXISTS aigc_context_user_turn ON aigc_context (self_id, user_id, turn);
`

/** 建表 */
export function initSchema(db) {
  db.exec(SCHEMA)
}
