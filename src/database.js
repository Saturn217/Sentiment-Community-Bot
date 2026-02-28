const { Pool } = require("pg");

// ─── Connection Pool ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Render PostgreSQL
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
      timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_timestamp ON sentiment(timestamp);
    CREATE INDEX IF NOT EXISTS idx_channel   ON sentiment(channel_id);
    CREATE INDEX IF NOT EXISTS idx_label     ON sentiment(label);
  `);
  console.log("✅ PostgreSQL database initialized.");
}

// ─── Writes ───────────────────────────────────────────────────────────────────

async function insertSentiment({ user_id, username, channel_id, channel_name, score, label }) {
  await pool.query(
    `INSERT INTO sentiment (user_id, username, channel_id, channel_name, score, label)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user_id, username, channel_id, channel_name, score, label]
  );
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Overall label breakdown for the last N days */
async function getSummary(days = 1) {
  const { rows } = await pool.query(`
    SELECT
      label,
      COUNT(*)::int        AS count,
      AVG(score)::float    AS avg_score
    FROM sentiment
    WHERE timestamp >= NOW() - INTERVAL '${days} days'
    GROUP BY label
    ORDER BY count DESC
  `);
  return rows;
}

/** Daily average scores for the last N days */
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

/** Per-channel sentiment for the last N days */
async function getChannelBreakdown(days = 1) {
  const { rows } = await pool.query(`
    SELECT
      channel_name,
      AVG(score)::float  AS avg_score,
      COUNT(*)::int      AS message_count
    FROM sentiment
    WHERE timestamp >= NOW() - INTERVAL '${days} days'
    GROUP BY channel_name
    ORDER BY message_count DESC
    LIMIT 10
  `);
  return rows;
}

/** Most active users with sentiment breakdown for the last N days */
async function getTopUsers(days = 1) {
  const { rows } = await pool.query(`
    SELECT
      username,
      AVG(score)::float  AS avg_score,
      COUNT(*)::int      AS message_count,
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

/** Total messages tracked in the last 24 hours */
async function getTodayCount() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM sentiment
    WHERE timestamp >= NOW() - INTERVAL '1 days'
  `);
  return rows[0];
}

module.exports = {
  initDB,
  insertSentiment,
  getSummary,
  getTrend,
  getChannelBreakdown,
  getTopUsers,
  getTodayCount,
};