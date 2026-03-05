const { EmbedBuilder } = require("discord.js");
const {
  getSummary, getTrend, getChannelBreakdown, getTopUsers, getTodayCount,
  getCategorySummary, getRecentIssues, getRecentFeedback,
} = require("./database");

// ─── Shared Report Data Fetcher ───────────────────────────────────────────────
async function fetchReportData() {
  const [summary, trend, channels, topUsers, { count }, categorySummary, recentIssues, recentFeedback] =
    await Promise.all([
      getSummary(1),
      getTrend(7),
      getChannelBreakdown(1),
      getTopUsers(1),
      getTodayCount(),
      getCategorySummary(1),
      getRecentIssues(1, 5),
      getRecentFeedback(1, 5),
    ]);
  return { summary, trend, channels, topUsers, count, categorySummary, recentIssues, recentFeedback };
}

// ─── Build Discord Embed ──────────────────────────────────────────────────────
async function buildDailyReport() {
  const { summary, trend, channels, topUsers, count, categorySummary, recentIssues, recentFeedback } =
    await fetchReportData();

  // Overall score
  let positive = 0, negative = 0, neutral = 0, totalScore = 0;
  summary.forEach(({ label, count: c, avg_score }) => {
    if (label === "positive") positive = c;
    if (label === "negative") negative = c;
    if (label === "neutral")  neutral  = c;
    totalScore += avg_score * c;
  });
  const overallScore = count > 0 ? totalScore / count : 0;

  // Mood
  let moodEmoji, moodLabel, embedColor;
  if (overallScore > 0.1)        { moodEmoji = "😄"; moodLabel = "Very Positive"; embedColor = 0x2ecc71; }
  else if (overallScore > 0.02)  { moodEmoji = "🙂"; moodLabel = "Positive";      embedColor = 0x27ae60; }
  else if (overallScore < -0.1)  { moodEmoji = "😠"; moodLabel = "Very Negative"; embedColor = 0xe74c3c; }
  else if (overallScore < -0.02) { moodEmoji = "😕"; moodLabel = "Negative";      embedColor = 0xc0392b; }
  else                           { moodEmoji = "😐"; moodLabel = "Neutral";        embedColor = 0xf39c12; }

  // Breakdown bar
  function buildBar(value, total, emoji) {
    if (!total) return "";
    const pct    = Math.round((value / total) * 100);
    const filled = Math.round(pct / 5);
    return `${emoji} ${"█".repeat(filled)}${"░".repeat(20 - filled)} ${pct}% (${value})`;
  }

  const breakdownText = count > 0
    ? [buildBar(positive, count, "🟢"), buildBar(neutral, count, "🟡"), buildBar(negative, count, "🔴")].join("\n")
    : "No messages tracked today.";

  // Trend
  let trendText = "";
  trend.length > 0
    ? trend.forEach(({ date, avg_score, message_count }) => {
        const arrow = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
        trendText += `${arrow} \`${date}\` — \`${avg_score > 0 ? "+" : ""}${avg_score.toFixed(3)}\` · ${message_count} msgs\n`;
      })
    : (trendText = "Not enough data yet.");

  // Channels
  let channelText = channels.length > 0
    ? channels.map(({ channel_name, avg_score, message_count }) => {
        const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        return `${mood} **#${channel_name}** — \`${avg_score.toFixed(3)}\` · ${message_count} msgs`;
      }).join("\n")
    : "No channel data available.";

  // Top users
  let usersText = topUsers.length > 0
    ? topUsers.slice(0, 3).map(({ username, avg_score, message_count }) => {
        const mood = avg_score > 0.05 ? "😊" : avg_score < -0.05 ? "😤" : "😐";
        return `${mood} **${username}** — avg: \`${avg_score.toFixed(3)}\` · ${message_count} msgs`;
      }).join("\n")
    : "Not enough user data yet (min. 3 messages).";

  // Issues & Feedback summary
  const issueCount    = categorySummary.find(c => c.category === "issue")?.count    || 0;
  const feedbackCount = categorySummary.find(c => c.category === "feedback")?.count || 0;

  const issuesText = recentIssues.length > 0
    ? recentIssues.map(({ username, message_text }) =>
        `🔴 **${username}**: ${message_text?.slice(0, 80)}${message_text?.length > 80 ? "..." : ""}`
      ).join("\n")
    : "✅ No issues reported today — community is happy!";

  const feedbackText = recentFeedback.length > 0
    ? recentFeedback.map(({ username, message_text }) =>
        `💬 **${username}**: ${message_text?.slice(0, 80)}${message_text?.length > 80 ? "..." : ""}`
      ).join("\n")
    : "📭 No feedback submitted today.";

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  return new EmbedBuilder()
    .setTitle(`${moodEmoji} Daily Sentiment Report — ${moodLabel}`)
    .setDescription(`**${today}**\nOverall score: \`${overallScore.toFixed(3)}\` · ${count || 0} messages analyzed`)
    .setColor(embedColor)
    .addFields(
      { name: "📊 Sentiment Breakdown",          value: `\`\`\`\n${breakdownText}\n\`\`\``, inline: false },
      { name: "📅 7-Day Trend",                  value: trendText,                           inline: false },
      { name: "📡 Top Channels",                 value: channelText,                         inline: true  },
      { name: "👥 Top Members",                  value: usersText,                           inline: true  },
      { name: `🐛 Issues Today (${issueCount})`, value: issuesText,                          inline: false },
      { name: `💡 Feedback Today (${feedbackCount})`, value: feedbackText,                   inline: false },
    )
    .setFooter({ text: "Sentiment Bot • Tracking community vibes daily" })
    .setTimestamp();
}

// ─── Build Telegram Report Text ───────────────────────────────────────────────
async function buildTelegramReport() {
  const { summary, trend, channels, topUsers, count, recentIssues, recentFeedback } =
    await fetchReportData();

  let positive = 0, negative = 0, neutral = 0, totalScore = 0;
  summary.forEach(({ label, count: c, avg_score }) => {
    if (label === "positive") positive = c;
    if (label === "negative") negative = c;
    if (label === "neutral")  neutral  = c;
    totalScore += avg_score * c;
  });
  const overallScore = count > 0 ? totalScore / count : 0;

  let moodEmoji, moodLabel;
  if (overallScore > 0.1)        { moodEmoji = "😄"; moodLabel = "Very Positive"; }
  else if (overallScore > 0.02)  { moodEmoji = "🙂"; moodLabel = "Positive";      }
  else if (overallScore < -0.1)  { moodEmoji = "😠"; moodLabel = "Very Negative"; }
  else if (overallScore < -0.02) { moodEmoji = "😕"; moodLabel = "Negative";      }
  else                           { moodEmoji = "😐"; moodLabel = "Neutral";        }

  function buildBar(value, total, emoji) {
    if (!total) return `${emoji} 0%`;
    const pct    = Math.round((value / total) * 100);
    const filled = Math.round(pct / 10);
    return `${emoji} ${"█".repeat(filled)}${"░".repeat(10 - filled)} ${pct}% (${value})`;
  }

  const breakdownText = count > 0
    ? `${buildBar(positive, count, "🟢")}\n${buildBar(neutral, count, "🟡")}\n${buildBar(negative, count, "🔴")}`
    : "No messages tracked today.";

  let trendText = "";
  trend.slice(-5).forEach(({ date, avg_score, message_count }) => {
    const arrow = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
    trendText += `${arrow} \`${date}\` — \`${avg_score > 0 ? "+" : ""}${avg_score.toFixed(3)}\` · ${message_count} msgs\n`;
  });

  const issuesText = recentIssues.length > 0
    ? recentIssues.map(({ username, message_text }) =>
        `🔴 *${username}*: ${message_text?.slice(0, 80)}${message_text?.length > 80 ? "..." : ""}`
      ).join("\n")
    : "✅ No issues reported today — community is happy!";

  const feedbackText = recentFeedback.length > 0
    ? recentFeedback.map(({ username, message_text }) =>
        `💬 *${username}*: ${message_text?.slice(0, 80)}${message_text?.length > 80 ? "..." : ""}`
      ).join("\n")
    : "📭 No feedback submitted today.";

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  return `${moodEmoji} *Daily Sentiment Report — ${moodLabel}*
📅 ${today}
Overall score: \`${overallScore.toFixed(3)}\` · ${count || 0} messages analyzed

📊 *Sentiment Breakdown*
\`\`\`
${breakdownText}
\`\`\`
📅 *7\\-Day Trend*
${trendText || "Not enough data yet."}
🐛 *Issues Today*
${issuesText}

💡 *Feedback Today*
${feedbackText}

_Sentiment Bot • Tracking community vibes daily_`;
}

// ─── Send to Discord ──────────────────────────────────────────────────────────
async function sendDailyReport(client) {
  const channelId = process.env.REPORT_CHANNEL_ID;
  if (!channelId) {
    console.warn("⚠️  REPORT_CHANNEL_ID not set — skipping Discord report.");
    return;
  }
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      console.error("❌ Report channel not found or is not a text channel.");
      return;
    }
    const embed = await buildDailyReport();
    await channel.send({ embeds: [embed] });
    console.log(`✅ Discord daily report sent to #${channel.name}`);
  } catch (err) {
    console.error("❌ Failed to send Discord report:", err.message);
  }
}

module.exports = { sendDailyReport, buildDailyReport, buildTelegramReport };