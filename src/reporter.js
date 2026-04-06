const { EmbedBuilder } = require("discord.js");
const {
  getSummary, getTrend, getChannelBreakdown, getTopUsers, getTodayCount,
  getCategorySummary, getRecentIssues, getRecentFeedback, getCommunityBreakdown,
  getWeeklyStats, getWeeklyTopUsers, getWeeklyIssuesAndFeedback,
} = require("./database");

// ─── Shared Helpers ───────────────────────────────────────────────────────────
function getMood(score) {
  if (score > 0.1)   return { emoji: "😄", label: "Very Positive", color: 0x2ecc71 };
  if (score > 0.02)  return { emoji: "🙂", label: "Positive",      color: 0x27ae60 };
  if (score < -0.1)  return { emoji: "😠", label: "Very Negative", color: 0xe74c3c };
  if (score < -0.02) return { emoji: "😕", label: "Negative",      color: 0xc0392b };
  return               { emoji: "😐", label: "Neutral",        color: 0xf39c12 };
}

function buildBar(value, total, emoji, width = 20) {
  if (!total) return `${emoji} 0%`;
  const pct    = Math.round((value / total) * 100);
  const filled = Math.round(pct / (100 / width));
  return `${emoji} ${"█".repeat(filled)}${"░".repeat(width - filled)} ${pct}% (${value})`;
}

/** Convert raw score to plain English that anyone can understand */
function scoreToWords(score) {
  if (score > 0.3)   return "🔥 Very happy";
  if (score > 0.1)   return "😄 Happy";
  if (score > 0.02)  return "🙂 Mostly positive";
  if (score > -0.02) return "😐 Mixed / neutral";
  if (score > -0.1)  return "😕 A bit negative";
  if (score > -0.3)  return "😠 Unhappy";
  return               "🚨 Very unhappy";
}

/** Format a date value (string or Date) to a short readable format e.g. "Fri Mar 13" */
function formatDate(dateVal) {
  const d = new Date(dateVal);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Generate a plain-English summary of what the community is talking about */
function buildCommunitySummary(positive, negative, neutral, count, issueCount, feedbackCount) {
  if (count === 0) return "No messages tracked today.";

  const posRatio = Math.round((positive / count) * 100);
  const negRatio = Math.round((negative / count) * 100);

  let summary = "";

  // Overall vibe
  if (posRatio >= 70)       summary += `The community is in great spirits today — ${posRatio}% of messages were positive. `;
  else if (posRatio >= 50)  summary += `The community is mostly positive today with ${posRatio}% upbeat messages. `;
  else if (negRatio >= 50)  summary += `The community is having a tough day — ${negRatio}% of messages were negative. `;
  else if (negRatio >= 30)  summary += `There's some frustration in the community today (${negRatio}% negative). `;
  else                      summary += `The community mood is mixed today. `;

  // Issues
  if (issueCount > 5)       summary += `⚠️ ${issueCount} issues were reported — worth investigating. `;
  else if (issueCount > 0)  summary += `${issueCount} issue${issueCount > 1 ? "s were" : " was"} reported. `;
  else                      summary += `No issues reported. `;

  // Feedback
  if (feedbackCount > 0)    summary += `${feedbackCount} feedback item${feedbackCount > 1 ? "s" : ""} received.`;

  return summary.trim();
}


// ─── Daily Report Data ────────────────────────────────────────────────────────
async function fetchReportData() {
  const [summary, trend, channels, topUsers, { count }, categorySummary, recentIssues, recentFeedback, communities] =
    await Promise.all([
      getSummary(1), getTrend(7), getChannelBreakdown(1), getTopUsers(1), getTodayCount(),
      getCategorySummary(1), getRecentIssues(1,5), getRecentFeedback(1,5), getCommunityBreakdown(1),
    ]);
  return { summary, trend, channels, topUsers, count, categorySummary, recentIssues, recentFeedback, communities };
}

// ─── Daily Discord Embed ──────────────────────────────────────────────────────
async function buildDailyReport() {
  const { summary, trend, channels, topUsers, count, categorySummary, recentIssues, recentFeedback, communities } = await fetchReportData();

  let positive = 0, negative = 0, neutral = 0, totalScore = 0;
  summary.forEach(({ label, count: c, avg_score }) => {
    if (label === "positive") positive = c;
    if (label === "negative") negative = c;
    if (label === "neutral")  neutral  = c;
    totalScore += avg_score * c;
  });
  const overallScore = count > 0 ? totalScore / count : 0;
  const { emoji: moodEmoji, label: moodLabel, color: embedColor } = getMood(overallScore);

  const issueCount    = categorySummary.find(c => c.category === "issue")?.count    || 0;
  const feedbackCount = categorySummary.find(c => c.category === "feedback")?.count || 0;

  // Plain English summary of today
  const communitySummary = buildCommunitySummary(positive, negative, neutral, count, issueCount, feedbackCount);

  const breakdownText = count > 0
    ? [buildBar(positive, count, "🟢"), buildBar(neutral, count, "🟡"), buildBar(negative, count, "🔴")].join("\n")
    : "No messages tracked today.";

  // Human-readable trend — short date + plain English score
  const trendText = trend.length > 0
    ? trend.map(({ date, avg_score, message_count }) => {
        const arrow  = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
        const words  = scoreToWords(avg_score);
        const short  = formatDate(date);
        return `${arrow} **${short}** — ${words} · ${message_count} msg${message_count !== 1 ? "s" : ""}`;
      }).join("\n")
    : "Not enough data yet.";

  const channelText = channels.length > 0
    ? channels.map(({ community, channel_name, platform, avg_score, message_count }) => {
        const mood  = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        const plat  = platform === "telegram" ? "📱" : "💬";
        const words = scoreToWords(avg_score);
        return `${mood}${plat} **${community}/#${channel_name}** — ${words} · ${message_count} msg${message_count !== 1 ? "s" : ""}`;
      }).join("\n")
    : "No channel data available.";

  const usersText = topUsers.length > 0
    ? topUsers.slice(0, 3).map(({ username, community, avg_score, message_count }) => {
        const mood  = avg_score > 0.05 ? "😊" : avg_score < -0.05 ? "😤" : "😐";
        const words = scoreToWords(avg_score);
        return `${mood} **${username}** (${community}) — ${words} · ${message_count} msg${message_count !== 1 ? "s" : ""}`;
      }).join("\n")
    : "Not enough user data yet (min. 3 messages).";

  const communityText = communities.length > 0
    ? communities.map(({ community, platform, message_count, avg_score }) => {
        const plat  = platform === "telegram" ? "📱" : "💬";
        const mood  = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        const words = scoreToWords(avg_score);
        return `${mood}${plat} **${community}** — ${words} · ${message_count} msg${message_count !== 1 ? "s" : ""}`;
      }).join("\n")
    : "No community data yet.";

  const issuesText = recentIssues.length > 0
    ? recentIssues.map(({ username, community, message_text }) =>
        `🔴 **${username}** [${community}]: ${message_text?.slice(0, 200)}${message_text?.length > 200 ? "..." : ""}`
      ).join("\n")
    : "✅ No issues reported today — community is happy!";

  const feedbackText = recentFeedback.length > 0
    ? recentFeedback.map(({ username, community, message_text }) =>
        `💬 **${username}** [${community}]: ${message_text?.slice(0, 200)}${message_text?.length > 200 ? "..." : ""}`
      ).join("\n")
    : "📭 No feedback submitted today.";

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  return new EmbedBuilder()
    .setTitle(`${moodEmoji} Daily Sentiment Report — ${moodLabel}`)
    .setDescription(
      `**${today}**\n\n` +
      `📝 **What's happening:** ${communitySummary}\n\n` +
      `📊 **Community mood:** ${scoreToWords(overallScore)} · ${count || 0} messages analyzed`
    )
    .setColor(embedColor)
    .addFields(
      { name: "🌐 Communities Today",                value: communityText,                       inline: false },
      { name: "📊 Sentiment Breakdown",              value: `\`\`\`\n${breakdownText}\n\`\`\``, inline: false },
      { name: "📅 7-Day Trend",                      value: trendText,                           inline: false },
      { name: "📡 Top Channels",                     value: channelText,                         inline: true  },
      { name: "👥 Top Members",                      value: usersText,                           inline: true  },
      { name: `🐛 Issues Today (${issueCount})`,     value: issuesText,                          inline: false },
      { name: `💡 Feedback Today (${feedbackCount})`,value: feedbackText,                        inline: false },
    )
    .setFooter({ text: "Sentiment Bot • Tracking community vibes daily" })
    .setTimestamp();
}

// ─── Daily Telegram Text ──────────────────────────────────────────────────────
async function buildTelegramReport() {
  const { summary, trend, count, recentIssues, recentFeedback, communities, categorySummary } = await fetchReportData();

  let positive = 0, negative = 0, neutral = 0, totalScore = 0;
  summary.forEach(({ label, count: c, avg_score }) => {
    if (label === "positive") positive = c;
    if (label === "negative") negative = c;
    if (label === "neutral")  neutral  = c;
    totalScore += avg_score * c;
  });
  const overallScore  = count > 0 ? totalScore / count : 0;
  const { emoji: moodEmoji } = getMood(overallScore);
  const issueCount    = categorySummary?.find(c => c.category === "issue")?.count    || 0;
  const feedbackCount = categorySummary?.find(c => c.category === "feedback")?.count || 0;
  const communitySummary = buildCommunitySummary(positive, negative, neutral, count, issueCount, feedbackCount);

  // Escape * and _ in user content to prevent broken Markdown
  const esc = str => (str || "").replace(/([*_`[])/g, "\\$1");

  // Breakdown bars
  const pct    = n  => count > 0 ? Math.round((n / count) * 100) : 0;
  const miniBar = (n, emoji) => {
    const p = pct(n); const f = Math.round(p / 10);
    return `${emoji} ${"█".repeat(f)}${"░".repeat(10 - f)} *${p}%* _(${n} msgs)_`;
  };
  const breakdownText = count > 0
    ? `${miniBar(positive, "🟢")}\n${miniBar(neutral, "🟡")}\n${miniBar(negative, "🔴")}`
    : "_No messages tracked today._";

  // 7-day trend (last 5 days)
  const trendLines = trend.slice(-5).map(({ date, avg_score, message_count }) => {
    const arrow = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
    return `${arrow} *${formatDate(date)}* — ${scoreToWords(avg_score)} · ${message_count} msgs`;
  }).join("\n") || "_Not enough data yet._";

  // Communities
  const communityLines = communities.length > 0
    ? communities.map(({ community, platform, message_count, avg_score }) => {
        const plat = platform === "telegram" ? "📱" : "💬";
        const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        return `${mood}${plat} *${esc(community)}*\n     ${scoreToWords(avg_score)} · ${message_count} msgs`;
      }).join("\n\n")
    : "_No community data yet._";

  // Issues
  const issueLines = recentIssues.length > 0
    ? recentIssues.map(({ username, community, message_text }) => {
        const preview = esc((message_text || "").slice(0, 150));
        const tail    = (message_text || "").length > 150 ? "..." : "";
        return `🔴 *${esc(username)}* · _${esc(community)}_\n_"${preview}${tail}"_`;
      }).join("\n\n")
    : "✅ _No issues reported today_";

  // Feedback
  const feedbackLines = recentFeedback.length > 0
    ? recentFeedback.map(({ username, community, message_text }) => {
        const preview = esc((message_text || "").slice(0, 150));
        const tail    = (message_text || "").length > 150 ? "..." : "";
        return `💬 *${esc(username)}* · _${esc(community)}_\n_"${preview}${tail}"_`;
      }).join("\n\n")
    : "📭 _No feedback submitted today_";

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const D = "━━━━━━━━━━━━━━━━━━━━";

  return [
    `${moodEmoji} *Daily Sentiment Report*`,
    `_${today}_`,
    ``,
    `_${communitySummary}_`,
    ``,
    `*Overall Mood:* ${scoreToWords(overallScore)} · *${count || 0}* messages`,
    ``,
    D,
    `🌐 *Communities Today*`,
    ``,
    communityLines,
    ``,
    D,
    `📊 *Sentiment Breakdown*`,
    ``,
    breakdownText,
    ``,
    D,
    `📅 *7-Day Trend*`,
    ``,
    trendLines,
    ``,
    D,
    `🐛 *Issues Today* _(${issueCount})_`,
    ``,
    issueLines,
    ``,
    D,
    `💡 *Feedback Today* _(${feedbackCount})_`,
    ``,
    feedbackLines,
    ``,
    D,
    `_Sentiment Bot · Daily Report_`,
  ].join("\n");
}

// ─── Weekly Discord Embed ─────────────────────────────────────────────────────
async function buildWeeklyDigest() {
  const [weeklyStats, topUsers, { issues, feedback }, communities] = await Promise.all([
    getWeeklyStats(), getWeeklyTopUsers(), getWeeklyIssuesAndFeedback(), getCommunityBreakdown(7),
  ]);

  let totalMsgs = 0, totalScore = 0, totalPositive = 0, totalNegative = 0, totalNeutral = 0, totalIssues = 0, totalFeedback = 0;
  weeklyStats.forEach(({ message_count, avg_score, positive_count, negative_count, neutral_count, issue_count, feedback_count }) => {
    totalMsgs += message_count; totalScore += avg_score * message_count;
    totalPositive += positive_count; totalNegative += negative_count; totalNeutral += neutral_count;
    totalIssues += issue_count; totalFeedback += feedback_count;
  });
  const overallScore = totalMsgs > 0 ? totalScore / totalMsgs : 0;
  const { emoji: moodEmoji, label: moodLabel, color: embedColor } = getMood(overallScore);

  const uniqueDays = [...new Set(weeklyStats.map(r => String(r.date)))];
  const trendText = uniqueDays.map(date => {
    const dayRows  = weeklyStats.filter(r => String(r.date) === date);
    const dayMsgs  = dayRows.reduce((s, r) => s + r.message_count, 0);
    const dayScore = dayRows.reduce((s, r) => s + r.avg_score * r.message_count, 0) / (dayMsgs || 1);
    const arrow    = dayScore > 0.05 ? "📈" : dayScore < -0.05 ? "📉" : "➡️";
    return `${arrow} **${formatDate(date)}** — ${scoreToWords(dayScore)} · ${dayMsgs} msgs`;
  }).join("\n") || "No data.";

  const communityText = communities.length > 0
    ? communities.map(({ community, platform, message_count, avg_score, positive_count, negative_count }) => {
        const plat = platform === "telegram" ? "📱" : "💬";
        const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        return `${mood}${plat} **${community}** — ${scoreToWords(avg_score)} · ${message_count} msgs`;
      }).join("\n")
    : "No community data.";

  const topUsersText = topUsers.length > 0
    ? topUsers.slice(0, 5).map(({ username, community, message_count, avg_score }) => {
        const mood = avg_score > 0.05 ? "😊" : avg_score < -0.05 ? "😤" : "😐";
        return `${mood} **${username}** (${community}) — ${message_count} msgs · ${scoreToWords(avg_score)}`;
      }).join("\n")
    : "Not enough data this week (min. 5 messages).";

  // Limit each issue/feedback to 80 chars to stay within Discord's 1024 char field limit
  const issuesText = issues.length > 0
    ? issues.slice(0, 5).map(({ username, community, message_text }) =>
        `🔴 **${username}** [${community}]\n> ${message_text?.slice(0, 80)}${message_text?.length > 80 ? "..." : ""}`
      ).join("\n")
    : "✅ No issues this week!";

  const feedbackText = feedback.length > 0
    ? feedback.slice(0, 5).map(({ username, community, message_text }) =>
        `💬 **${username}** [${community}]\n> ${message_text?.slice(0, 80)}${message_text?.length > 80 ? "..." : ""}`
      ).join("\n")
    : "📭 No feedback this week.";

  const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 7);
  const weekRange = `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  return new EmbedBuilder()
    .setTitle(`📋 Weekly Digest — ${moodEmoji} ${moodLabel}`)
    .setDescription(
      `**${weekRange}**\n\n` +
      `📨 **${totalMsgs}** messages · 😊 **${totalPositive}** positive · 😠 **${totalNegative}** negative · 😐 **${totalNeutral}** neutral\n` +
      `🐛 **${totalIssues}** issues · 💡 **${totalFeedback}** feedback items\n` +
      `Overall mood: ${scoreToWords(overallScore)}`
    )
    .setColor(embedColor)
    .addFields(
      { name: "📅 Day-by-Day Trend",          value: trendText     || "No data", inline: false },
      { name: "🌐 Community Performance",      value: communityText || "No data", inline: false },
      { name: "🏆 Top Contributors This Week", value: topUsersText,               inline: false },
      { name: `🐛 Top Issues (${issues.length})`,    value: issuesText,   inline: false },
      { name: `💡 Top Feedback (${feedback.length})`,value: feedbackText, inline: false },
    )
    .setFooter({ text: "Sentiment Bot • Weekly Digest" })
    .setTimestamp();
}

// ─── Weekly Telegram Text ─────────────────────────────────────────────────────
async function buildWeeklyDigestTelegram() {
  const [weeklyStats, { issues, feedback }, communities] = await Promise.all([
    getWeeklyStats(), getWeeklyIssuesAndFeedback(), getCommunityBreakdown(7),
  ]);

  let totalMsgs = 0, totalScore = 0, totalIssues = 0, totalFeedback = 0;
  let totalPositive = 0, totalNegative = 0, totalNeutral = 0;
  weeklyStats.forEach(({ message_count, avg_score, issue_count, feedback_count, positive_count, negative_count, neutral_count }) => {
    totalMsgs     += message_count; totalScore    += avg_score * message_count;
    totalIssues   += issue_count;   totalFeedback += feedback_count;
    totalPositive += positive_count || 0;
    totalNegative += negative_count || 0;
    totalNeutral  += neutral_count  || 0;
  });
  const overallScore = totalMsgs > 0 ? totalScore / totalMsgs : 0;
  const { emoji: moodEmoji } = getMood(overallScore);

  const esc = str => (str || "").replace(/([*_`[])/g, "\\$1");

  // Day-by-day trend
  const uniqueDays = [...new Set(weeklyStats.map(r => String(r.date)))];
  const trendLines = uniqueDays.map(date => {
    const dayRows  = weeklyStats.filter(r => String(r.date) === date);
    const dayMsgs  = dayRows.reduce((s, r) => s + r.message_count, 0);
    const dayScore = dayRows.reduce((s, r) => s + r.avg_score * r.message_count, 0) / (dayMsgs || 1);
    const arrow    = dayScore > 0.05 ? "📈" : dayScore < -0.05 ? "📉" : "➡️";
    return `${arrow} *${formatDate(date)}* — ${scoreToWords(dayScore)} · ${dayMsgs} msgs`;
  }).join("\n") || "_No data._";

  // Community performance
  const communityLines = communities.length > 0
    ? communities.map(({ community, platform, message_count, avg_score }) => {
        const plat = platform === "telegram" ? "📱" : "💬";
        const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        return `${mood}${plat} *${esc(community)}*\n     ${scoreToWords(avg_score)} · ${message_count} msgs`;
      }).join("\n\n")
    : "_No community data._";

  // Issues
  const issueLines = issues.slice(0, 3).map(({ username, community, message_text }) => {
    const preview = esc((message_text || "").slice(0, 150));
    const tail    = (message_text || "").length > 150 ? "..." : "";
    return `🔴 *${esc(username)}* · _${esc(community)}_\n_"${preview}${tail}"_`;
  }).join("\n\n") || "✅ _No issues this week_";

  // Feedback
  const feedbackLines = feedback.slice(0, 3).map(({ username, community, message_text }) => {
    const preview = esc((message_text || "").slice(0, 150));
    const tail    = (message_text || "").length > 150 ? "..." : "";
    return `💬 *${esc(username)}* · _${esc(community)}_\n_"${preview}${tail}"_`;
  }).join("\n\n") || "📭 _No feedback this week_";

  const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 7);
  const weekRange = `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const D = "━━━━━━━━━━━━━━━━━━━━";

  return [
    // ── Message 1: Overview + Trend + Communities ──
    [
      `📋 *Weekly Digest* ${moodEmoji}`,
      `_${weekRange}_`,
      ``,
      `📨 *${totalMsgs}* messages tracked this week`,
      `😊 *${totalPositive}* positive  😐 *${totalNeutral}* neutral  😠 *${totalNegative}* negative`,
      `🐛 *${totalIssues}* issues reported  💡 *${totalFeedback}* feedback received`,
      ``,
      `*Overall Mood:* ${scoreToWords(overallScore)}`,
      ``,
      D,
      `📅 *Day-by-Day Trend*`,
      ``,
      trendLines,
      ``,
      D,
      `🌐 *Community Performance*`,
      ``,
      communityLines,
    ].join("\n"),

    // ── Message 2: Issues + Feedback ──
    [
      `🐛 *Top Issues This Week* _(${issues.length})_`,
      ``,
      issueLines,
      ``,
      D,
      `💡 *Top Feedback This Week* _(${feedback.length})_`,
      ``,
      feedbackLines,
      ``,
      D,
      `_Sentiment Bot · Weekly Digest_`,
    ].join("\n"),
  ];
}

// ─── Send Functions ───────────────────────────────────────────────────────────
async function sendDailyReport(client) {
  const channelId = process.env.REPORT_CHANNEL_ID;
  if (!channelId) { console.warn("⚠️  REPORT_CHANNEL_ID not set — skipping."); return; }
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) { console.error("❌ Report channel not found."); return; }
    await channel.send({ embeds: [await buildDailyReport()] });
    console.log(`✅ Discord daily report sent to #${channel.name}`);
  } catch (err) { console.error("❌ Failed to send Discord report:", err.message); }
}

async function sendWeeklyDigest(client) {
  const channelId = process.env.REPORT_CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;
    await channel.send({ embeds: [await buildWeeklyDigest()] });
    console.log("✅ Weekly digest sent to Discord.");
  } catch (err) { console.error("❌ Failed to send weekly digest:", err.message); }
}

module.exports = { sendDailyReport, buildDailyReport, buildTelegramReport, buildWeeklyDigest, buildWeeklyDigestTelegram, sendWeeklyDigest };