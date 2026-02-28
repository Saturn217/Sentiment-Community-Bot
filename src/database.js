const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "../sentiment.db"));

// Enable WAL mode for better performance
db.pragma("journal_mode = WAL");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sentiment (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    username    TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    score       REAL NOT NULL,
    label       TEXT NOT NULL,
    timestamp   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_timestamp ON sentiment(timestamp);
  CREATE INDEX IF NOT EXISTS idx_channel   ON sentiment(channel_id);
  CREATE INDEX IF NOT EXISTS idx_label     ON sentiment(label);
`);

// ─── Writes ────────────────────────────────────────────────────────────────

const insertStmt = db.prepare(`
  INSERT INTO sentiment (user_id, username, channel_id, channel_name, score, label, timestamp)
  VALUES (@user_id, @username, @channel_id, @channel_name, @score, @label, @timestamp)
`);

function insertSentiment(data) {
  insertStmt.run({ ...data, timestamp: new Date().toISOString() });
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/** Overall label breakdown for the last N days */
function getSummary(days = 1) {
  return db.prepare(`
    SELECT
      label,
      COUNT(*)       AS count,
      AVG(score)     AS avg_score
    FROM sentiment
    WHERE timestamp >= datetime('now', '-${days} days')
    GROUP BY label
    ORDER BY count DESC
  `).all();
}

/** Daily average scores for the last N days */
function getTrend(days = 7) {
  return db.prepare(`
    SELECT
      DATE(timestamp)  AS date,
      AVG(score)       AS avg_score,
      COUNT(*)         AS message_count
    FROM sentiment
    WHERE timestamp >= datetime('now', '-${days} days')
    GROUP BY DATE(timestamp)
    ORDER BY date ASC
  `).all();
}

/** Per-channel sentiment for the last N days */
function getChannelBreakdown(days = 1) {
  return db.prepare(`
    SELECT
      channel_name,
      AVG(score)   AS avg_score,
      COUNT(*)     AS message_count
    FROM sentiment
    WHERE timestamp >= datetime('now', '-${days} days')
    GROUP BY channel_name
    ORDER BY message_count DESC
    LIMIT 10
  `).all();
}

/** Most active positive and negative users in the last N days */
function getTopUsers(days = 1) {
  return db.prepare(`
    SELECT
      username,
      AVG(score)   AS avg_score,
      COUNT(*)     AS message_count,
      SUM(CASE WHEN label = 'positive' THEN 1 ELSE 0 END) AS positive_count,
      SUM(CASE WHEN label = 'negative' THEN 1 ELSE 0 END) AS negative_count
    FROM sentiment
    WHERE timestamp >= datetime('now', '-${days} days')
    GROUP BY user_id
    HAVING message_count >= 3
    ORDER BY avg_score DESC
    LIMIT 5
  `).all();
}

/** Total messages tracked today */
function getTodayCount() {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM sentiment
    WHERE timestamp >= datetime('now', '-1 days')
  `).get();
}

module.exports = {
  insertSentiment,
  getSummary,
  getTrend,
  getChannelBreakdown,
  getTopUsers,
  getTodayCount,
};