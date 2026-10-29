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
`

/** FTS5 全文索引 — trigram 分词支持中文子串检索 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS aigc_message_fts USING fts5(
  content,
  content='aigc_message',
  content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS aigc_message_fts_ai AFTER INSERT ON aigc_message BEGIN
  INSERT INTO aigc_message_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS aigc_message_fts_ad AFTER DELETE ON aigc_message BEGIN
  INSERT INTO aigc_message_fts(aigc_message_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS aigc_message_fts_au AFTER UPDATE ON aigc_message BEGIN
  INSERT INTO aigc_message_fts(aigc_message_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO aigc_message_fts(rowid, content) VALUES (new.id, new.content);
END;
`

/** 建表；返回 FTS5 是否可用 */
export function initSchema(db) {
  db.exec(SCHEMA)
  try {
    const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='aigc_message_fts'").get()
    db.exec(FTS_SCHEMA)
    // 首次创建：为已有历史补建索引
    if (!existed) db.exec("INSERT INTO aigc_message_fts(aigc_message_fts) VALUES('rebuild')")
    return true
  } catch {
    return false
  }
}
