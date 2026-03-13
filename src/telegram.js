const https = require("https");
const { getSummary, getTrend, getChannelBreakdown, getRecentIssues, getRecentFeedback, insertSentiment } = require("./database");
const { buildTelegramReport } = require("./reporter");
const { analyzeSentiment } = require("./sentiment");
const { classifyMessage }  = require("./classifier");

const TG_TOKEN          = process.env.TELEGRAM_TOKEN;
const TG_REPORT_CHAT_ID = process.env.TELEGRAM_REPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

// Groups to MONITOR (track sentiment from)
const TG_MONITOR_1  = process.env.TELEGRAM_CHAT_ID;
const TG_MONITOR_2  = process.env.TELEGRAM_CHAT_ID_2;
const COMMUNITY_1   = process.env.TG_COMMUNITY_NAME   || "Orderly Telegram Community";
const COMMUNITY_2   = process.env.TG_COMMUNITY_NAME_2 || "Orderly Trading Competition";

// Map monitored chat IDs to community names
const CHAT_COMMUNITY_MAP = {
  [TG_MONITOR_1]: COMMUNITY_1,
  [TG_MONITOR_2]: COMMUNITY_2,
};
let offset = 0;

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
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
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
    await tgRequest("sendMessage", { chat_id, text: text.replace(/[*`_[\]()~>#+=|{}.!-]/g, "\\$&") });
  }
}

// ─── Track Telegram Messages ──────────────────────────────────────────────────
async function trackTelegramMessage(msg) {
  if (!msg?.text) return;
  if (msg.text.startsWith("/")) return;

  const text = msg.text.trim();
  if (text.length < 5) return;

  const stripped = text.replace(/https?:\/\/\S+/g, "").trim();
  if (stripped.length < 5) return;

  const chatId    = String(msg.chat?.id);
  const community = CHAT_COMMUNITY_MAP[chatId] || `telegram_${chatId}`;

  const { score, label } = analyzeSentiment(stripped);
  const category         = classifyMessage(stripped);

  try {
    await insertSentiment({
      message_id:   String(msg.message_id),
      user_id:      String(msg.from?.id || "unknown"),
      username:     msg.from?.username || msg.from?.first_name || "unknown",
      channel_id:   chatId,
      channel_name: msg.chat?.title || community,
      score,
      label,
      category,
      message_text: stripped.slice(0, 300),
      community,
      platform:     "telegram",
    });
    console.log(`📨 Tracked [${community}] ${label} message from ${msg.from?.username || "unknown"}`);
  } catch (err) {
    console.error("❌ Failed to track Telegram message:", err.message);
  }
}

// ─── Command Handlers ─────────────────────────────────────────────────────────
async function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text || "").toLowerCase();

  try {
    if (text.startsWith("/report")) {
      await sendMessage(chatId, "⏳ Generating combined report...");
      const report = await buildTelegramReport();
      await sendMessage(chatId, report);

    } else if (text.startsWith("/sentiment")) {
      const days    = parseInt(text.split(" ")[1]) || 7;
      const summary = await getSummary(days);
      const trend   = await getTrend(days);

      if (!summary.length) return sendMessage(chatId, "📭 No sentiment data yet across any community.");

      let totalMsgs = 0, weightedScore = 0, summaryText = "";
      summary.forEach(({ label, count, avg_score }) => {
        const emoji = label === "positive" ? "🟢" : label === "negative" ? "🔴" : "🟡";
        summaryText += `${emoji} *${label}*: ${count} msgs (avg: \`${avg_score.toFixed(3)}\`)\n`;
        totalMsgs += count; weightedScore += avg_score * count;
      });

      let trendText = "";
      trend.slice(-5).forEach(({ date, avg_score, message_count }) => {
        const arrow = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
        trendText += `${arrow} \`${date}\` — \`${avg_score > 0 ? "+" : ""}${avg_score.toFixed(3)}\` (${message_count} msgs)\n`;
      });

      await sendMessage(chatId,
        `📊 *Combined Sentiment — Last ${days} Day${days > 1 ? "s" : ""}*\n\n` +
        `*Breakdown:*\n${summaryText}\n*Trend:*\n${trendText || "Not enough data yet."}`
      );

    } else if (text.startsWith("/channels")) {
      const days      = parseInt(text.split(" ")[1]) || 1;
      const breakdown = await getChannelBreakdown(days);
      if (!breakdown.length) return sendMessage(chatId, "📭 No channel data available yet.");

      const channelText = breakdown.map(({ community, channel_name, platform, avg_score, message_count }) => {
        const mood      = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        const platEmoji = platform === "telegram" ? "📱" : "💬";
        return `${mood}${platEmoji} *${community}/#${channel_name}* — \`${avg_score.toFixed(3)}\` · ${message_count} msgs`;
      }).join("\n");

      await sendMessage(chatId, `📡 *Channel Sentiment — Last ${days} Day${days > 1 ? "s" : ""}*\n\n${channelText}`);

    } else if (text.startsWith("/issues")) {
      const days   = parseInt(text.split(" ")[1]) || 1;
      const issues = await getRecentIssues(days, 10);
      if (!issues.length) return sendMessage(chatId, `✅ No issues across any community in the last ${days} day${days > 1 ? "s" : ""}!`);

      const issueText = issues.map(({ username, community, platform, message_text }) => {
        const platEmoji = platform === "telegram" ? "📱" : "💬";
        return `🔴${platEmoji} *${username}* \\[${community}\\]:\n_${message_text?.slice(0, 100)}${message_text?.length > 100 ? "..." : ""}_`;
      }).join("\n\n");

      await sendMessage(chatId, `🐛 *Issues — Last ${days} Day${days > 1 ? "s" : ""}* (${issues.length} found)\n\n${issueText}`);

    } else if (text.startsWith("/feedback")) {
      const days     = parseInt(text.split(" ")[1]) || 1;
      const feedback = await getRecentFeedback(days, 10);
      if (!feedback.length) return sendMessage(chatId, `📭 No feedback across any community in the last ${days} day${days > 1 ? "s" : ""}.`);

      const feedbackText = feedback.map(({ username, community, platform, message_text }) => {
        const platEmoji = platform === "telegram" ? "📱" : "💬";
        return `💬${platEmoji} *${username}* \\[${community}\\]:\n_${message_text?.slice(0, 100)}${message_text?.length > 100 ? "..." : ""}_`;
      }).join("\n\n");

      await sendMessage(chatId, `💡 *Feedback — Last ${days} Day${days > 1 ? "s" : ""}* (${feedback.length} found)\n\n${feedbackText}`);

    } else if (text.startsWith("/communities")) {
      const { getCommunityBreakdown } = require("./database");
      const breakdown = await getCommunityBreakdown(7);
      if (!breakdown.length) return sendMessage(chatId, "📭 No community data yet.");

      const comText = breakdown.map(({ community, platform, message_count, avg_score, positive_count, negative_count }) => {
        const platEmoji = platform === "telegram" ? "📱" : "💬";
        const mood      = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        return `${mood}${platEmoji} *${community}*\n   ${message_count} msgs · avg: \`${avg_score.toFixed(3)}\` · 😊${positive_count} 😠${negative_count}`;
      }).join("\n\n");

      await sendMessage(chatId, `🌐 *Community Breakdown — Last 7 Days*\n\n${comText}`);

    } else if (text.startsWith("/start") || text.startsWith("/help")) {
      await sendMessage(chatId,
        `👋 *Otterly Sentiment Bot*\n\n` +
        `Tracking sentiment across all your communities.\n\n` +
        `*Commands:*\n` +
        `/report — Combined daily report\n` +
        `/sentiment \\[days\\] — Sentiment summary\n` +
        `/channels \\[days\\] — Per\\-channel breakdown\n` +
        `/issues \\[days\\] — Recent issues\n` +
        `/feedback \\[days\\] — Recent feedback\n` +
        `/communities — All communities overview\n` +
        `/help — Show this message`
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
      timeout:         25,
      allowed_updates: ["message"],
    });

    if (res.ok && res.result.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;

        if (msg.text?.startsWith("/")) {
          await handleCommand(msg);
        } else {
          // Only track messages from monitored groups, NOT the report chat
          const msgChatId   = String(msg.chat?.id);
          const isMonitored = msgChatId === String(TG_MONITOR_1) || msgChatId === String(TG_MONITOR_2);
          if (isMonitored) {
            await trackTelegramMessage(msg);
          }
        }
      }
    }
  } catch (err) {
    const isNormal = err.message?.includes("socket hang up") ||
                     err.message?.includes("ECONNRESET") ||
                     err.message?.includes("ETIMEDOUT");
    if (!isNormal) console.error("❌ Telegram poll error:", err.message);
    await new Promise((r) => setTimeout(r, 3000));
  }

  setImmediate(poll);
}

// ─── Daily Report ─────────────────────────────────────────────────────────────
async function sendTelegramDailyReport() {
  const reportChatId = process.env.TELEGRAM_REPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

  if (!reportChatId) {
    console.warn("⚠️  No TELEGRAM_REPORT_CHAT_ID set — skipping Telegram report.");
    return;
  }

  try {
    const report = await buildTelegramReport();
    await sendMessage(reportChatId, report);
    console.log(`✅ Telegram daily report sent to report channel.`);
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
  console.log(`🤖 Telegram bot started`);
  if (TG_MONITOR_1)      console.log(`   📊 Monitoring: ${COMMUNITY_1} (${TG_MONITOR_1})`);
  if (TG_MONITOR_2)      console.log(`   📊 Monitoring: ${COMMUNITY_2} (${TG_MONITOR_2})`);
  if (TG_REPORT_CHAT_ID) console.log(`   📬 Reports to: ${TG_REPORT_CHAT_ID}`);
  poll();
}

module.exports = { startTelegramBot, sendTelegramDailyReport, trackTelegramMessage, sendTelegramMessage: sendMessage };