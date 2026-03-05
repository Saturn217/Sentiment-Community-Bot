const https = require("https");
const { getSummary, getTrend, getChannelBreakdown, getRecentIssues, getRecentFeedback } = require("./database");
const { buildTelegramReport } = require("./reporter");

const TG_TOKEN = process.env.TELEGRAM_TOKEN;
let offset     = 0;

// ─── HTTP Helper ──────────────────────────────────────────────────────────────
function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data    = JSON.stringify(body);
    const options = {
      hostname: "api.telegram.org",
      path:     `/bot${TG_TOKEN}/${method}`,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
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

async function sendMessage(chat_id, text) {
  try {
    await tgRequest("sendMessage", { chat_id, text, parse_mode: "Markdown" });
  } catch (err) {
    // Retry without markdown if formatting fails
    await tgRequest("sendMessage", { chat_id, text: text.replace(/[*`_]/g, ""), parse_mode: "" });
  }
}

// ─── Command Handlers ─────────────────────────────────────────────────────────
async function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text || "").toLowerCase();

  try {
    if (text.startsWith("/report")) {
      await sendMessage(chatId, "⏳ Generating report...");
      const report = await buildTelegramReport();
      await sendMessage(chatId, report);

    } else if (text.startsWith("/sentiment")) {
      const days    = parseInt(text.split(" ")[1]) || 7;
      const summary = await getSummary(days);
      const trend   = await getTrend(days);

      if (!summary.length) {
        return sendMessage(chatId, "📭 No sentiment data yet. Send some messages first!");
      }

      let totalMsgs = 0, weightedScore = 0, summaryText = "";
      summary.forEach(({ label, count, avg_score }) => {
        const emoji = label === "positive" ? "🟢" : label === "negative" ? "🔴" : "🟡";
        summaryText += `${emoji} *${label}*: ${count} msgs (avg: \`${avg_score.toFixed(3)}\`)\n`;
        totalMsgs     += count;
        weightedScore += avg_score * count;
      });

      let trendText = "";
      trend.slice(-5).forEach(({ date, avg_score, message_count }) => {
        const arrow = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
        trendText += `${arrow} \`${date}\` — \`${avg_score.toFixed(3)}\` (${message_count} msgs)\n`;
      });

      await sendMessage(chatId,
        `📊 *Sentiment — Last ${days} Day${days > 1 ? "s" : ""}*\n\n` +
        `*Breakdown:*\n${summaryText}\n` +
        `*Trend:*\n${trendText || "Not enough data yet."}`
      );

    } else if (text.startsWith("/channels")) {
      const days      = parseInt(text.split(" ")[1]) || 1;
      const breakdown = await getChannelBreakdown(days);

      if (!breakdown.length) {
        return sendMessage(chatId, "📭 No channel data available yet.");
      }

      const channelText = breakdown.map(({ channel_name, avg_score, message_count }) => {
        const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        return `${mood} *#${channel_name}* — \`${avg_score.toFixed(3)}\` · ${message_count} msgs`;
      }).join("\n");

      await sendMessage(chatId, `📡 *Channel Sentiment — Last ${days} Day${days > 1 ? "s" : ""}*\n\n${channelText}`);

    } else if (text.startsWith("/issues")) {
      const days   = parseInt(text.split(" ")[1]) || 1;
      const issues = await getRecentIssues(days, 10);

      if (!issues.length) {
        return sendMessage(chatId, `✅ No issues reported in the last ${days} day${days > 1 ? "s" : ""}!`);
      }

      const issueText = issues.map(({ username, channel_name, message_text }) =>
        `🔴 *${username}* in #${channel_name}:\n_${message_text?.slice(0, 100)}${message_text?.length > 100 ? "..." : ""}_`
      ).join("\n\n");

      await sendMessage(chatId, `🐛 *Issues — Last ${days} Day${days > 1 ? "s" : ""}* (${issues.length} found)\n\n${issueText}`);

    } else if (text.startsWith("/feedback")) {
      const days     = parseInt(text.split(" ")[1]) || 1;
      const feedback = await getRecentFeedback(days, 10);

      if (!feedback.length) {
        return sendMessage(chatId, `📭 No feedback submitted in the last ${days} day${days > 1 ? "s" : ""}.`);
      }

      const feedbackText = feedback.map(({ username, channel_name, message_text }) =>
        `💬 *${username}* in #${channel_name}:\n_${message_text?.slice(0, 100)}${message_text?.length > 100 ? "..." : ""}_`
      ).join("\n\n");

      await sendMessage(chatId, `💡 *Feedback — Last ${days} Day${days > 1 ? "s" : ""}* (${feedback.length} found)\n\n${feedbackText}`);

    } else if (text.startsWith("/start") || text.startsWith("/help")) {
      await sendMessage(chatId,
        `👋 *Otterly Sentiment Bot*\n\n` +
        `I track your Discord community sentiment, issues and feedback.\n\n` +
        `*Commands:*\n` +
        `/report — Full daily sentiment report\n` +
        `/sentiment [days] — Sentiment summary\n` +
        `/channels [days] — Per\\-channel breakdown\n` +
        `/issues [days] — Recent issues reported\n` +
        `/feedback [days] — Recent feedback submitted\n` +
        `/help — Show this message\n\n` +
        `_Default lookback is 1 day. Add a number for more e.g. /issues 7_`
      );
    }
  } catch (err) {
    console.error("❌ Telegram command error:", err.message);
    await sendMessage(chatId, "⚠️ An error occurred. Please try again.");
  }
}

// ─── Long Polling ─────────────────────────────────────────────────────────────
async function poll() {
  try {
    const res = await tgRequest("getUpdates", {
      offset,
      timeout:         30,
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
    await new Promise((r) => setTimeout(r, 5000)); // wait 5s before retrying
  }

  setImmediate(poll);
}

// ─── Send Daily Report ────────────────────────────────────────────────────────
async function sendTelegramDailyReport() {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.warn("⚠️  TELEGRAM_CHAT_ID not set — skipping Telegram report.");
    return;
  }
  try {
    const report = await buildTelegramReport();
    await sendMessage(chatId, report);
    console.log("✅ Telegram daily report sent.");
  } catch (err) {
    console.error("❌ Failed to send Telegram report:", err.message);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
function startTelegramBot() {
  if (!TG_TOKEN) {
    console.warn("⚠️  TELEGRAM_TOKEN not set — Telegram bot disabled.");
    return;
  }
  console.log("🤖 Telegram bot started, polling for messages...");
  poll();
}

module.exports = { startTelegramBot, sendTelegramDailyReport };