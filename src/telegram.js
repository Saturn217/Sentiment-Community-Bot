const https = require("https");
const { getSummary, getTrend, getChannelBreakdown, getTopUsers, getTodayCount } = require("./database");

const TG_TOKEN   = process.env.TELEGRAM_TOKEN;
const TG_API     = `https://api.telegram.org/bot${TG_TOKEN}`;
let offset       = 0;

// ─── HTTP Helper ──────────────────────────────────────────────────────────────
function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: "api.telegram.org",
      path:     `/bot${TG_TOKEN}/${method}`,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => resolve(JSON.parse(raw)));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─── Send Message ─────────────────────────────────────────────────────────────
async function sendMessage(chat_id, text, parse_mode = "Markdown") {
  return tgRequest("sendMessage", { chat_id, text, parse_mode });
}

// ─── Build Report Text ────────────────────────────────────────────────────────
async function buildReportText(days = 1) {
  const summary  = await getSummary(days);
  const trend    = await getTrend(7);
  const channels = await getChannelBreakdown(days);
  const topUsers = await getTopUsers(days);
  const { count } = await getTodayCount();

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
  let moodEmoji, moodLabel;
  if (overallScore > 0.1)        { moodEmoji = "😄"; moodLabel = "Very Positive"; }
  else if (overallScore > 0.02)  { moodEmoji = "🙂"; moodLabel = "Positive";      }
  else if (overallScore < -0.1)  { moodEmoji = "😠"; moodLabel = "Very Negative"; }
  else if (overallScore < -0.02) { moodEmoji = "😕"; moodLabel = "Negative";      }
  else                           { moodEmoji = "😐"; moodLabel = "Neutral";        }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // Breakdown bar
  function buildBar(value, total, emoji) {
    if (!total) return `${emoji} 0%`;
    const pct    = Math.round((value / total) * 100);
    const filled = Math.round(pct / 10);
    return `${emoji} ${"█".repeat(filled)}${"░".repeat(10 - filled)} ${pct}% (${value})`;
  }

  const breakdownText = count > 0
    ? `${buildBar(positive, count, "🟢")}\n${buildBar(neutral, count, "🟡")}\n${buildBar(negative, count, "🔴")}`
    : "No messages tracked today.";

  // Trend
  let trendText = "";
  if (trend.length > 0) {
    trend.slice(-5).forEach(({ date, avg_score, message_count }) => {
      const arrow = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
      trendText += `${arrow} \`${date}\` — \`${avg_score > 0 ? "+" : ""}${avg_score.toFixed(3)}\` · ${message_count} msgs\n`;
    });
  } else {
    trendText = "Not enough data yet.";
  }

  // Channels
  let channelText = "";
  if (channels.length > 0) {
    channels.slice(0, 5).forEach(({ channel_name, avg_score, message_count }) => {
      const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
      channelText += `${mood} *#${channel_name}* — \`${avg_score.toFixed(3)}\` · ${message_count} msgs\n`;
    });
  } else {
    channelText = "No channel data available.";
  }

  // Top users
  let usersText = "";
  if (topUsers.length > 0) {
    topUsers.slice(0, 3).forEach(({ username, avg_score, message_count }) => {
      const mood = avg_score > 0.05 ? "😊" : avg_score < -0.05 ? "😤" : "😐";
      usersText += `${mood} *${username}* — avg: \`${avg_score.toFixed(3)}\` · ${message_count} msgs\n`;
    });
  } else {
    usersText = "Not enough data yet (min. 3 messages).";
  }

  return `${moodEmoji} *Daily Sentiment Report — ${moodLabel}*
📅 ${today}
Overall score: \`${overallScore.toFixed(3)}\` · ${count || 0} messages analyzed

📊 *Sentiment Breakdown*
\`\`\`
${breakdownText}
\`\`\`

📅 *7-Day Trend*
${trendText}
📡 *Top Channels (Today)*
${channelText}
👥 *Top Members (Today)*
${usersText}
_Sentiment Bot • Tracking community vibes daily_`;
}

// ─── Handle Commands ──────────────────────────────────────────────────────────
async function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text   = msg.text || "";

  if (text.startsWith("/report")) {
    await sendMessage(chatId, "⏳ Generating report...");
    const report = await buildReportText(1);
    await sendMessage(chatId, report);

  } else if (text.startsWith("/sentiment")) {
    const parts = text.split(" ");
    const days  = parseInt(parts[1]) || 7;
    const summary = await getSummary(days);
    const trend   = await getTrend(days);

    if (!summary.length) {
      return sendMessage(chatId, "📭 No sentiment data found yet. Send some messages first!");
    }

    let totalMsgs = 0, weightedScore = 0, summaryText = "";
    summary.forEach(({ label, count, avg_score }) => {
      const emoji = label === "positive" ? "🟢" : label === "negative" ? "🔴" : "🟡";
      summaryText += `${emoji} *${label}*: ${count} msgs (avg: \`${avg_score.toFixed(3)}\`)\n`;
      totalMsgs     += count;
      weightedScore += avg_score * count;
    });

    let trendText = "";
    trend.forEach(({ date, avg_score, message_count }) => {
      const arrow = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
      trendText += `${arrow} \`${date}\` — \`${avg_score.toFixed(3)}\` (${message_count} msgs)\n`;
    });

    await sendMessage(chatId,
      `📊 *Sentiment Summary — Last ${days} Day${days > 1 ? "s" : ""}*\n\n` +
      `*Breakdown:*\n${summaryText}\n` +
      `*Trend:*\n${trendText || "Not enough data yet."}`
    );

  } else if (text.startsWith("/channels")) {
    const parts = text.split(" ");
    const days  = parseInt(parts[1]) || 1;
    const breakdown = await getChannelBreakdown(days);

    if (!breakdown.length) {
      return sendMessage(chatId, "📭 No channel data available yet.");
    }

    let channelText = "";
    breakdown.forEach(({ channel_name, avg_score, message_count }) => {
      const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
      channelText += `${mood} *#${channel_name}* — \`${avg_score.toFixed(3)}\` · ${message_count} msgs\n`;
    });

    await sendMessage(chatId,
      `📡 *Channel Sentiment — Last ${days} Day${days > 1 ? "s" : ""}*\n\n${channelText}`
    );

  } else if (text.startsWith("/start") || text.startsWith("/help")) {
    await sendMessage(chatId,
      `👋 *Orderly Community Report Bot*\n\n` +
      `I track your Discord community sentiment and report it here.\n\n` +
      `*Commands:*\n` +
      `/report — Today's full sentiment report\n` +
      `/sentiment [days] — Summary for last N days\n` +
      `/channels [days] — Per-channel breakdown\n` +
      `/help — Show this message`
    );
  }
}

// ─── Poll for Updates ─────────────────────────────────────────────────────────
async function poll() {
  try {
    const res = await tgRequest("getUpdates", {
      offset,
      timeout: 30,
      allowed_updates: ["message"],
    });

    if (res.ok && res.result.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        if (update.message?.text?.startsWith("/")) {
          await handleCommand(update.message);
        }
      }
    }
  } catch (err) {
    console.error("❌ Telegram poll error:", err.message);
  }

  // Poll again immediately
  setImmediate(poll);
}

// ─── Send Daily Report to TG Group ───────────────────────────────────────────
async function sendTelegramDailyReport() {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.warn("⚠️  TELEGRAM_CHAT_ID not set — skipping Telegram report.");
    return;
  }
  try {
    const report = await buildReportText(1);
    await sendMessage(chatId, report);
    console.log("✅ Telegram daily report sent.");
  } catch (err) {
    console.error("❌ Failed to send Telegram report:", err.message);
  }
}

// ─── Start Telegram Bot ───────────────────────────────────────────────────────
function startTelegramBot() {
  if (!TG_TOKEN) {
    console.warn("⚠️  TELEGRAM_TOKEN not set — Telegram bot disabled.");
    return;
  }
  console.log("🤖 Telegram bot started, polling for messages...");
  poll();
}

module.exports = { startTelegramBot, sendTelegramDailyReport };