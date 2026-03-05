const { Pool } = require("pg");

// ─── Connection Pool ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Initialize Tables ────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sentiment (
      id           SERIAL PRIMARY KEY,
      user_id      TEXT        NOT NULL,
      username     TEXT        NOT NULL,
      channel_id   TEXT        NOT NULL,
      channel_name TEXT        NOT NULL,
      score        REAL        NOT NULL,
      label        TEXT        NOT NULL,
      category     TEXT        NOT NULL DEFAULT 'general',
      message_text TEXT,
      timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_timestamp ON sentiment(timestamp);
    CREATE INDEX IF NOT EXISTS idx_channel   ON sentiment(channel_id);
    CREATE INDEX IF NOT EXISTS idx_label     ON sentiment(label);
    CREATE INDEX IF NOT EXISTS idx_category  ON sentiment(category);
  `);

  // Add columns if upgrading from old schema
  await pool.query(`
    ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS category     TEXT DEFAULT 'general';
    ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS message_text TEXT;
  `).catch(() => {});

  console.log("✅ PostgreSQL database initialized.");
}

// ─── Writes ───────────────────────────────────────────────────────────────────

async function insertSentiment({ user_id, username, channel_id, channel_name, score, label, category, message_text }) {
  await pool.query(
    `INSERT INTO sentiment (user_id, username, channel_id, channel_name, score, label, category, message_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [user_id, username, channel_id, channel_name, score, label, category || "general", message_text || null]
  );
}

// ─── Sentiment Reads ──────────────────────────────────────────────────────────

async function getSummary(days = 1) {
  const { rows } = await pool.query(`
    SELECT
      label,
      COUNT(*)::int     AS count,
      AVG(score)::float AS avg_score
    FROM sentiment
    WHERE timestamp >= NOW() - INTERVAL '${days} days'
    GROUP BY label
    ORDER BY count DESC
  `);
  return rows;
}

async function getTrend(days = 7) {
  const { rows } = await pool.query(`
    SELECT
      DATE(timestamp)       AS date,
      AVG(score)::float     AS avg_score,
      COUNT(*)::int         AS message_count
    FROM sentiment
    WHERE timestamp >= NOW() - INTERVAL '${days} days'
    GROUP BY DATE(timestamp)
    ORDER BY date ASC
  `);
  return rows;
}

async function getChannelBreakdown(days = 1) {
  const { rows } = await pool.query(`
    SELECT
      channel_name,
      AVG(score)::float AS avg_score,
      COUNT(*)::int     AS message_count
    FROM sentiment
    WHERE timestamp >= NOW() - INTERVAL '${days} days'
    GROUP BY channel_name
    ORDER BY message_count DESC
    LIMIT 10
  `);
  return rows;
}

async function getTopUsers(days = 1) {
  const { rows } = await pool.query(`
    SELECT
      username,
      AVG(score)::float AS avg_score,
      COUNT(*)::int     AS message_count,
      SUM(CASE WHEN label = 'positive' THEN 1 ELSE 0 END)::int AS positive_count,
      SUM(CASE WHEN label = 'negative' THEN 1 ELSE 0 END)::int AS negative_count
    FROM sentiment
    WHERE timestamp >= NOW() - INTERVAL '${days} days'
    GROUP BY user_id, username
    HAVING COUNT(*) >= 3
    ORDER BY avg_score DESC
    LIMIT 5
  `);
  return rows;
}

async function getTodayCount() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM sentiment
    WHERE timestamp >= NOW() - INTERVAL '1 days'
  `);
  return rows[0];
}

// ─── Issues & Feedback Reads ──────────────────────────────────────────────────

/** Count of issues and feedback in the last N days */
async function getCategorySummary(days = 1) {
  const { rows } = await pool.query(`
    SELECT
      category,
      COUNT(*)::int     AS count,
      AVG(score)::float AS avg_score
    FROM sentiment
    WHERE timestamp >= NOW() - INTERVAL '${days} days'
      AND category != 'general'
    GROUP BY category
    ORDER BY count DESC
  `);
  return rows;
}

/** Recent issues reported */
async function getRecentIssues(days = 1, limit = 5) {
  const { rows } = await pool.query(`
    SELECT
      username,
      channel_name,
      message_text,
      score::float AS score,
      timestamp
    FROM sentiment
    WHERE category    = 'issue'
      AND timestamp  >= NOW() - INTERVAL '${days} days'
      AND message_text IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `);
  return rows;
}

/** Recent feedback submitted */
async function getRecentFeedback(days = 1, limit = 5) {
  const { rows } = await pool.query(`
    SELECT
      username,
      channel_name,
      message_text,
      score::float AS score,
      timestamp
    FROM sentiment
    WHERE category    = 'feedback'
      AND timestamp  >= NOW() - INTERVAL '${days} days'
      AND message_text IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `);
  return rows;
}

/** Issues/feedback trend over last N days */
async function getCategoryTrend(days = 7) {
  const { rows } = await pool.query(`
    SELECT
      DATE(timestamp) AS date,
      category,
      COUNT(*)::int   AS count
    FROM sentiment
    WHERE timestamp >= NOW() - INTERVAL '${days} days'
      AND category != 'general'
    GROUP BY DATE(timestamp), category
    ORDER BY date ASC
  `);
  return rows;
}

module.exports = {
  initDB,
  insertSentiment,
  getSummary,
  getTrend,
  getChannelBreakdown,
  getTopUsers,
  getTodayCount,
  getCategorySummary,
  getRecentIssues,
  getRecentFeedback,
  getCategoryTrend,
};