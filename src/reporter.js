const { EmbedBuilder } = require("discord.js");
const { getSummary, getTrend, getChannelBreakdown, getTopUsers, getTodayCount } = require("./database");

/**
 * Builds a rich Discord embed for the daily sentiment report.
 */
async function buildDailyReport() {
  const summary    = await getSummary(1);
  const trend      = await getTrend(7);
  const channels   = await getChannelBreakdown(1);
  const topUsers   = await getTopUsers(1);
  const { count }  = await getTodayCount();

  // ── Totals ────────────────────────────────────────────────────────────────
  let positive = 0, negative = 0, neutral = 0, totalScore = 0;
  summary.forEach(({ label, count: c, avg_score }) => {
    if (label === "positive") positive = c;
    if (label === "negative") negative = c;
    if (label === "neutral")  neutral  = c;
    totalScore += avg_score * c;
  });
  const overallScore = count > 0 ? totalScore / count : 0;

  // ── Overall mood ──────────────────────────────────────────────────────────
  let moodEmoji, moodLabel, embedColor;
  if (overallScore > 0.1)        { moodEmoji = "😄"; moodLabel = "Very Positive"; embedColor = 0x2ecc71; }
  else if (overallScore > 0.02)  { moodEmoji = "🙂"; moodLabel = "Positive";      embedColor = 0x27ae60; }
  else if (overallScore < -0.1)  { moodEmoji = "😠"; moodLabel = "Very Negative"; embedColor = 0xe74c3c; }
  else if (overallScore < -0.02) { moodEmoji = "😕"; moodLabel = "Negative";      embedColor = 0xc0392b; }
  else                           { moodEmoji = "😐"; moodLabel = "Neutral";        embedColor = 0xf39c12; }

  // ── Sentiment breakdown bar ───────────────────────────────────────────────
  function buildBar(value, total, emoji) {
    if (!total) return "";
    const pct    = Math.round((value / total) * 100);
    const filled = Math.round(pct / 5);
    return `${emoji} ${"█".repeat(filled)}${"░".repeat(20 - filled)} ${pct}% (${value})`;
  }

  const breakdownText = count > 0
    ? [
        buildBar(positive, count, "🟢"),
        buildBar(neutral,  count, "🟡"),
        buildBar(negative, count, "🔴"),
      ].join("\n")
    : "No messages tracked today.";

  // ── 7-day trend ───────────────────────────────────────────────────────────
  let trendText = "";
  if (trend.length > 0) {
    trend.forEach(({ date, avg_score, message_count }) => {
      const arrow = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
      const bar   = avg_score > 0 ? `+${avg_score.toFixed(3)}` : avg_score.toFixed(3);
      trendText += `${arrow} \`${date}\` — Score: \`${bar}\` · ${message_count} msgs\n`;
    });
  } else {
    trendText = "Not enough data yet.";
  }

  // ── Channel breakdown ─────────────────────────────────────────────────────
  let channelText = "";
  if (channels.length > 0) {
    channels.forEach(({ channel_name, avg_score, message_count }) => {
      const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
      channelText += `${mood} **#${channel_name}** — \`${avg_score.toFixed(3)}\` · ${message_count} msgs\n`;
    });
  } else {
    channelText = "No channel data available.";
  }

  // ── Top users ─────────────────────────────────────────────────────────────
  let usersText = "";
  if (topUsers.length > 0) {
    topUsers.slice(0, 3).forEach(({ username, avg_score, message_count }) => {
      const mood = avg_score > 0.05 ? "😊" : avg_score < -0.05 ? "😤" : "😐";
      usersText += `${mood} **${username}** — avg: \`${avg_score.toFixed(3)}\` · ${message_count} msgs\n`;
    });
  } else {
    usersText = "Not enough user data yet (min. 3 messages required).";
  }

  // ── Date header ───────────────────────────────────────────────────────────
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // ── Build embed ───────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setTitle(`${moodEmoji} Daily Sentiment Report — ${moodLabel}`)
    .setDescription(`**${today}**\nOverall community score: \`${overallScore.toFixed(3)}\` · ${count || 0} messages analyzed`)
    .setColor(embedColor)
    .addFields(
      {
        name: "📊 Sentiment Breakdown",
        value: `\`\`\`\n${breakdownText}\n\`\`\``,
        inline: false,
      },
      {
        name: "📅 7-Day Trend",
        value: trendText,
        inline: false,
      },
      {
        name: "📡 Top Channels (Today)",
        value: channelText,
        inline: true,
      },
      {
        name: "👥 Top Members (Today)",
        value: usersText,
        inline: true,
      }
    )
    .setFooter({ text: "Sentiment Bot • Tracking community vibes daily" })
    .setTimestamp();

  return embed;
}

/**
 * Send the daily report to the configured channel.
 */
async function sendDailyReport(client) {
  const channelId = process.env.REPORT_CHANNEL_ID;
  if (!channelId) {
    console.warn("⚠️  REPORT_CHANNEL_ID not set — skipping daily report.");
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error("❌ Report channel not found or is not a text channel.");
      return;
    }

    const embed = await buildDailyReport();
    await channel.send({ embeds: [embed] });
    console.log(`✅ Daily report sent to #${channel.name}`);
  } catch (err) {
    console.error("❌ Failed to send daily report:", err.message);
  }
}

module.exports = { sendDailyReport, buildDailyReport };