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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id        SERIAL PRIMARY KEY,
      chat_id   TEXT        NOT NULL,
      role      TEXT        NOT NULL,
      content   TEXT        NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT        NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrations = [
    `ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS category     TEXT NOT NULL DEFAULT 'general'`,
    `ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS message_text TEXT`,
    `ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS message_id   TEXT`,
    `ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS community    TEXT NOT NULL DEFAULT 'discord_main'`,
    `ALTER TABLE sentiment ADD COLUMN IF NOT EXISTS platform     TEXT NOT NULL DEFAULT 'discord'`,
    `ALTER TABLE sentiment ALTER COLUMN message_text TYPE TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_timestamp  ON sentiment(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_channel    ON sentiment(channel_id)`,
    `CREATE INDEX IF NOT EXISTS idx_label      ON sentiment(label)`,
    `CREATE INDEX IF NOT EXISTS idx_category   ON sentiment(category)`,
    `CREATE INDEX IF NOT EXISTS idx_message_id ON sentiment(message_id)`,
    `CREATE INDEX IF NOT EXISTS idx_community  ON sentiment(community)`,
    `CREATE INDEX IF NOT EXISTS idx_platform   ON sentiment(platform)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_message_id ON sentiment(message_id) WHERE message_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_agent_chat_id ON agent_conversations(chat_id, timestamp)`,
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
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
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

async function deleteByUsername(username, days = 1) {
  const { rows } = await pool.query(`
    DELETE FROM sentiment
    WHERE username = $1
      AND timestamp >= NOW() - INTERVAL '${days} days'
      AND category IN ('issue', 'feedback')
    RETURNING id, category, message_text, timestamp
  `, [username]);
  return rows;
}

async function deleteAllByUser(username, userId) {
  // Deletes every record for a user regardless of category or age — used on ban
  const { rowCount } = await pool.query(
    `DELETE FROM sentiment WHERE username = $1 OR user_id = $2`,
    [username, String(userId)]
  );
  return rowCount;
}

async function deleteAllByUsername(username) {
  // Deletes ALL records matching username (case-insensitive, partial match) — used by /tgpurge
  const { rowCount } = await pool.query(
    `DELETE FROM sentiment WHERE username ILIKE $1`,
    [username]
  );
  return rowCount;
}

async function findByUsername(username) {
  const { rows } = await pool.query(`
    SELECT username, category, message_id, message_text, timestamp
    FROM sentiment
    WHERE username ILIKE $1
    ORDER BY timestamp DESC LIMIT 20
  `, [`%${username}%`]);
  return rows;
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

// ─── Conversation History ─────────────────────────────────────────────────────
async function getConversationHistory(chatId) {
  const { rows } = await pool.query(
    `SELECT role, content FROM agent_conversations
     WHERE chat_id = $1 ORDER BY timestamp DESC LIMIT 20`,
    [String(chatId)]
  );
  return rows.reverse(); // oldest first for correct Claude message ordering
}

async function saveConversationTurn(chatId, role, content) {
  await pool.query(
    `INSERT INTO agent_conversations (chat_id, role, content) VALUES ($1, $2, $3)`,
    [String(chatId), role, content]
  );
  // Keep only the latest 20 messages per chat (10 turns)
  await pool.query(
    `DELETE FROM agent_conversations
     WHERE chat_id = $1 AND id NOT IN (
       SELECT id FROM agent_conversations WHERE chat_id = $1
       ORDER BY timestamp DESC LIMIT 20
     )`,
    [String(chatId)]
  );
}

async function clearConversationHistory(chatId) {
  await pool.query(`DELETE FROM agent_conversations WHERE chat_id = $1`, [String(chatId)]);
}

// ─── Bot Settings ─────────────────────────────────────────────────────────────
async function getSetting(key) {
  const { rows } = await pool.query(`SELECT value FROM bot_settings WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO bot_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

// ─── Week-over-Week Comparison ────────────────────────────────────────────────
async function getWeekOverWeekComparison() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(CASE WHEN timestamp >= NOW() - INTERVAL '7 days' THEN 1 END)::int AS this_week,
      COUNT(CASE WHEN timestamp >= NOW() - INTERVAL '14 days' AND timestamp < NOW() - INTERVAL '7 days' THEN 1 END)::int AS last_week,
      AVG(CASE WHEN timestamp >= NOW() - INTERVAL '7 days' THEN score END)::float AS this_score,
      AVG(CASE WHEN timestamp >= NOW() - INTERVAL '14 days' AND timestamp < NOW() - INTERVAL '7 days' THEN score END)::float AS last_score,
      COUNT(CASE WHEN timestamp >= NOW() - INTERVAL '7 days' AND category = 'issue' THEN 1 END)::int AS this_issues,
      COUNT(CASE WHEN timestamp >= NOW() - INTERVAL '14 days' AND timestamp < NOW() - INTERVAL '7 days' AND category = 'issue' THEN 1 END)::int AS last_issues
    FROM sentiment
  `);
  return rows[0];
}

// ─── Weekly Volume (Mon → Sun per community) ─────────────────────────────────
async function getWeeklyVolume() {
  // Current ISO week: Monday 00:00 UTC → now
  const { rows: thisWeek } = await pool.query(`
    SELECT
      community, platform,
      TO_CHAR(DATE(timestamp), 'Dy DD Mon') AS day_label,
      DATE(timestamp)                        AS date,
      COUNT(*)::int                          AS message_count
    FROM sentiment
    WHERE timestamp >= date_trunc('week', NOW())
    GROUP BY community, platform, DATE(timestamp)
    ORDER BY DATE(timestamp) ASC, community
  `);

  // Previous ISO week: last Mon 00:00 UTC → last Sun 23:59 UTC
  const { rows: lastWeek } = await pool.query(`
    SELECT
      community, platform,
      TO_CHAR(DATE(timestamp), 'Dy DD Mon') AS day_label,
      DATE(timestamp)                        AS date,
      COUNT(*)::int                          AS message_count
    FROM sentiment
    WHERE timestamp >= date_trunc('week', NOW() - INTERVAL '7 days')
      AND timestamp <  date_trunc('week', NOW())
    GROUP BY community, platform, DATE(timestamp)
    ORDER BY DATE(timestamp) ASC, community
  `);

  // Week totals per community
  const { rows: totals } = await pool.query(`
    SELECT community, platform,
      SUM(CASE WHEN timestamp >= date_trunc('week', NOW()) THEN 1 ELSE 0 END)::int              AS this_week_total,
      SUM(CASE WHEN timestamp >= date_trunc('week', NOW() - INTERVAL '7 days')
               AND timestamp <  date_trunc('week', NOW()) THEN 1 ELSE 0 END)::int               AS last_week_total
    FROM sentiment
    WHERE timestamp >= date_trunc('week', NOW() - INTERVAL '7 days')
    GROUP BY community, platform
    ORDER BY community
  `);

  return { thisWeek, lastWeek, totals };
}

// ─── Alert Detection ──────────────────────────────────────────────────────────
async function detectSentimentSpike() {
  const { rows } = await pool.query(`
    SELECT
      AVG(CASE WHEN timestamp >= NOW() - INTERVAL '1 hour'   THEN score END)::float AS recent_avg,
      AVG(CASE WHEN timestamp >= NOW() - INTERVAL '24 hours' THEN score END)::float AS baseline_avg,
      COUNT(CASE WHEN timestamp >= NOW() - INTERVAL '1 hour' THEN 1 END)::int       AS recent_count
    FROM sentiment
  `);
  const { recent_avg, baseline_avg, recent_count } = rows[0];
  if (!recent_count || recent_count < 5) return null;
  if (baseline_avg === null || recent_avg === null) return null;
  const delta = baseline_avg - recent_avg;
  if (delta >= 0.3) return { type: "spike", recent_avg, baseline_avg, delta, recent_count };
  return null;
}

async function detectIssueSurge() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(CASE WHEN timestamp >= NOW() - INTERVAL '30 minutes' AND category = 'issue' THEN 1 END)::int AS recent_issues,
      (COUNT(CASE WHEN timestamp >= NOW() - INTERVAL '24 hours' AND category = 'issue' THEN 1 END) / 48.0)::float AS hourly_avg
    FROM sentiment
  `);
  const { recent_issues, hourly_avg } = rows[0];
  if (recent_issues < 3) return null;
  if (hourly_avg > 0 && recent_issues > hourly_avg * 3) return { type: "surge", recent_issues, hourly_avg };
  if (hourly_avg === 0 && recent_issues >= 5) return { type: "surge", recent_issues, hourly_avg };
  return null;
}

module.exports = {
  initDB, insertSentiment, deleteByMessageId, deleteByUsername, deleteAllByUser, deleteAllByUsername, findByUsername, cleanOldRecords,
  getSummary, getTrend, getChannelBreakdown, getTopUsers, getTodayCount,
  getCommunityBreakdown, getCategorySummary, getRecentIssues, getRecentFeedback, getCategoryTrend,
  getCustomKeywords, addCustomKeyword, removeCustomKeyword,
  getWeeklyStats, getWeeklyTopUsers, getWeeklyIssuesAndFeedback, getWeeklyVolume,
  getDashboardData,
  getConversationHistory, saveConversationTurn, clearConversationHistory,
  getSetting, setSetting,
  getWeekOverWeekComparison,
  detectSentimentSpike, detectIssueSurge,
};