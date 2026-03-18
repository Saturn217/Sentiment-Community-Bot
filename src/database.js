const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Initialize Tables ────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sentiment (
      id           SERIAL PRIMARY KEY,
      message_id   TEXT,
      user_id      TEXT        NOT NULL,
      username     TEXT        NOT NULL,
      channel_id   TEXT        NOT NULL,
      channel_name TEXT        NOT NULL,
      score        REAL        NOT NULL,
      label        TEXT        NOT NULL,
      timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_keywords (
      id        SERIAL PRIMARY KEY,
      keyword   TEXT NOT NULL UNIQUE,
      category  TEXT NOT NULL CHECK (category IN ('issue', 'feedback')),
      added_by  TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrations = [
    `ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS category     TEXT NOT NULL DEFAULT 'general'`,
    `ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS message_text TEXT`,
    `ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS message_id   TEXT`,
    `ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS community    TEXT NOT NULL DEFAULT 'discord_main'`,
    `ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS platform     TEXT NOT NULL DEFAULT 'discord'`,
    `CREATE INDEX IF NOT EXISTS idx_timestamp  ON sentiment(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_channel    ON sentiment(channel_id)`,
    `CREATE INDEX IF NOT EXISTS idx_label      ON sentiment(label)`,
    `CREATE INDEX IF NOT EXISTS idx_category   ON sentiment(category)`,
    `CREATE INDEX IF NOT EXISTS idx_message_id ON sentiment(message_id)`,
    `CREATE INDEX IF NOT EXISTS idx_community  ON sentiment(community)`,
    `CREATE INDEX IF NOT EXISTS idx_platform   ON sentiment(platform)`,
  ];

  for (const sql of migrations) {
    try {
      await pool.query(sql);
      console.log(`✅ Migration OK: ${sql.slice(0, 60)}...`);
    } catch (err) {
      console.error(`❌ Migration failed: ${sql.slice(0, 60)}\n   Error: ${err.message}`);
    }
  }

  console.log("✅ PostgreSQL database initialized.");
}

// ─── Writes ───────────────────────────────────────────────────────────────────
async function insertSentiment({ message_id, user_id, username, channel_id, channel_name, score, label, category, message_text, community, platform }) {
  await pool.query(
    `INSERT INTO sentiment (message_id, user_id, username, channel_id, channel_name, score, label, category, message_text, community, platform)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [message_id||null, user_id, username, channel_id, channel_name, score, label, category||"general", message_text||null, community||"discord_main", platform||"discord"]
  );
}

async function deleteByMessageId(message_id) {
  const result = await pool.query(
    `DELETE FROM sentiment WHERE message_id = $1 RETURNING id, category, timestamp`,
    [message_id]
  );
  return result.rows[0] || null;
}

async function cleanOldRecords() {
  const { rows: before } = await pool.query(`
    SELECT category, COUNT(*)::int AS total,
      SUM(CASE WHEN message_id IS NULL THEN 1 ELSE 0 END)::int AS no_id
    FROM sentiment WHERE category IN ('issue','feedback') GROUP BY category
  `);
  const { rowCount } = await pool.query(`
    DELETE FROM sentiment WHERE category IN ('issue','feedback') AND message_id IS NULL
  `);
  return { before, deleted: rowCount };
}

// ─── Reads ────────────────────────────────────────────────────────────────────
async function getSummary(days = 1) {
  const { rows } = await pool.query(`
    SELECT label, COUNT(*)::int AS count, AVG(score)::float AS avg_score
    FROM sentiment WHERE timestamp >= NOW() - INTERVAL '${days} days'
    GROUP BY label ORDER BY count DESC
  `);
  return rows;
}

async function getTrend(days = 7) {
  const { rows } = await pool.query(`
    SELECT DATE(timestamp) AS date, AVG(score)::float AS avg_score, COUNT(*)::int AS message_count
    FROM sentiment WHERE timestamp >= NOW() - INTERVAL '${days} days'
    GROUP BY DATE(timestamp) ORDER BY date ASC
  `);
  return rows;
}

async function getChannelBreakdown(days = 1) {
  const { rows } = await pool.query(`
    SELECT community, channel_name, platform, AVG(score)::float AS avg_score, COUNT(*)::int AS message_count
    FROM sentiment WHERE timestamp >= NOW() - INTERVAL '${days} days'
    GROUP BY community, channel_name, platform ORDER BY message_count DESC LIMIT 10
  `);
  return rows;
}

async function getTopUsers(days = 1) {
  const { rows } = await pool.query(`
    SELECT username, community, platform,
      AVG(score)::float AS avg_score, COUNT(*)::int AS message_count,
      SUM(CASE WHEN label='positive' THEN 1 ELSE 0 END)::int AS positive_count,
      SUM(CASE WHEN label='negative' THEN 1 ELSE 0 END)::int AS negative_count
    FROM sentiment WHERE timestamp >= NOW() - INTERVAL '${days} days'
    GROUP BY user_id, username, community, platform
    HAVING COUNT(*) >= 3 ORDER BY avg_score DESC LIMIT 5
  `);
  return rows;
}

async function getTodayCount() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM sentiment WHERE timestamp >= NOW() - INTERVAL '1 days'
  `);
  return rows[0];
}

async function getCommunityBreakdown(days = 1) {
  const { rows } = await pool.query(`
    SELECT community, platform,
      COUNT(*)::int AS message_count, AVG(score)::float AS avg_score,
      SUM(CASE WHEN label='positive' THEN 1 ELSE 0 END)::int AS positive_count,
      SUM(CASE WHEN label='negative' THEN 1 ELSE 0 END)::int AS negative_count,
      SUM(CASE WHEN label='neutral'  THEN 1 ELSE 0 END)::int AS neutral_count
    FROM sentiment WHERE timestamp >= NOW() - INTERVAL '${days} days'
    GROUP BY community, platform ORDER BY message_count DESC
  `);
  return rows;
}

async function getCategorySummary(days = 1) {
  const { rows } = await pool.query(`
    SELECT category, COUNT(*)::int AS count, AVG(score)::float AS avg_score
    FROM sentiment WHERE timestamp >= NOW() - INTERVAL '${days} days' AND category != 'general'
    GROUP BY category ORDER BY count DESC
  `);
  return rows;
}

async function getRecentIssues(days = 1, limit = 5) {
  const { rows } = await pool.query(`
    SELECT username, channel_name, community, platform, message_id, message_text, score::float AS score, timestamp
    FROM sentiment
    WHERE category='issue' AND timestamp >= NOW() - INTERVAL '${days} days' AND message_text IS NOT NULL
    ORDER BY timestamp DESC LIMIT ${limit}
  `);
  return rows;
}

async function getRecentFeedback(days = 1, limit = 5) {
  const { rows } = await pool.query(`
    SELECT username, channel_name, community, platform, message_id, message_text, score::float AS score, timestamp
    FROM sentiment
    WHERE category='feedback' AND timestamp >= NOW() - INTERVAL '${days} days' AND message_text IS NOT NULL
    ORDER BY timestamp DESC LIMIT ${limit}
  `);
  return rows;
}

async function getCategoryTrend(days = 7) {
  const { rows } = await pool.query(`
    SELECT DATE(timestamp) AS date, category, COUNT(*)::int AS count
    FROM sentiment WHERE timestamp >= NOW() - INTERVAL '${days} days' AND category != 'general'
    GROUP BY DATE(timestamp), category ORDER BY date ASC
  `);
  return rows;
}

// ─── Custom Keywords ──────────────────────────────────────────────────────────
async function getCustomKeywords() {
  const { rows } = await pool.query(`SELECT * FROM custom_keywords ORDER BY category, keyword`);
  return rows;
}

async function addCustomKeyword(keyword, category, added_by) {
  const { rows } = await pool.query(
    `INSERT INTO custom_keywords (keyword, category, added_by) VALUES ($1,$2,$3)
     ON CONFLICT (keyword) DO UPDATE SET category=$2, added_by=$3 RETURNING *`,
    [keyword.toLowerCase(), category, added_by]
  );
  return rows[0];
}

async function removeCustomKeyword(keyword) {
  const { rows } = await pool.query(
    `DELETE FROM custom_keywords WHERE keyword=$1 RETURNING *`,
    [keyword.toLowerCase()]
  );
  return rows[0] || null;
}

// ─── Weekly Digest ────────────────────────────────────────────────────────────
async function getWeeklyStats() {
  const { rows } = await pool.query(`
    SELECT DATE(timestamp) AS date, community, platform,
      COUNT(*)::int AS message_count, AVG(score)::float AS avg_score,
      SUM(CASE WHEN label='positive'    THEN 1 ELSE 0 END)::int AS positive_count,
      SUM(CASE WHEN label='negative'    THEN 1 ELSE 0 END)::int AS negative_count,
      SUM(CASE WHEN label='neutral'     THEN 1 ELSE 0 END)::int AS neutral_count,
      SUM(CASE WHEN category='issue'    THEN 1 ELSE 0 END)::int AS issue_count,
      SUM(CASE WHEN category='feedback' THEN 1 ELSE 0 END)::int AS feedback_count
    FROM sentiment WHERE timestamp >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(timestamp), community, platform ORDER BY date ASC
  `);
  return rows;
}

async function getWeeklyTopUsers() {
  const { rows } = await pool.query(`
    SELECT username, community, platform,
      COUNT(*)::int AS message_count, AVG(score)::float AS avg_score,
      SUM(CASE WHEN label='positive' THEN 1 ELSE 0 END)::int AS positive_count,
      SUM(CASE WHEN label='negative' THEN 1 ELSE 0 END)::int AS negative_count
    FROM sentiment WHERE timestamp >= NOW() - INTERVAL '7 days'
    GROUP BY user_id, username, community, platform
    HAVING COUNT(*) >= 5 ORDER BY message_count DESC LIMIT 10
  `);
  return rows;
}

async function getWeeklyIssuesAndFeedback() {
  const issues   = await getRecentIssues(7, 10);
  const feedback = await getRecentFeedback(7, 10);
  return { issues, feedback };
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function getDashboardData() {
  const [dailyTrend, communityBreakdown, recentIssues, recentFeedback, topUsers, categorySummary] =
    await Promise.all([getTrend(30), getCommunityBreakdown(30), getRecentIssues(7,20), getRecentFeedback(7,20), getTopUsers(7), getCategorySummary(7)]);

  const { rows: stats } = await pool.query(`
    SELECT COUNT(*)::int AS total_messages, AVG(score)::float AS avg_score,
      SUM(CASE WHEN label='positive'    THEN 1 ELSE 0 END)::int AS positive_count,
      SUM(CASE WHEN label='negative'    THEN 1 ELSE 0 END)::int AS negative_count,
      SUM(CASE WHEN label='neutral'     THEN 1 ELSE 0 END)::int AS neutral_count,
      SUM(CASE WHEN category='issue'    THEN 1 ELSE 0 END)::int AS issue_count,
      SUM(CASE WHEN category='feedback' THEN 1 ELSE 0 END)::int AS feedback_count
    FROM sentiment WHERE timestamp >= NOW() - INTERVAL '30 days'
  `);
  return { totalStats: stats[0], dailyTrend, communityBreakdown, recentIssues, recentFeedback, topUsers, categorySummary };
}

module.exports = {
  initDB, insertSentiment, deleteByMessageId, cleanOldRecords,
  getSummary, getTrend, getChannelBreakdown, getTopUsers, getTodayCount,
  getCommunityBreakdown, getCategorySummary, getRecentIssues, getRecentFeedback, getCategoryTrend,
  getCustomKeywords, addCustomKeyword, removeCustomKeyword,
  getWeeklyStats, getWeeklyTopUsers, getWeeklyIssuesAndFeedback,
  getDashboardData,
};