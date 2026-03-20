const https = require("https");
const {
  getSummary, getTrend, getChannelBreakdown, getRecentIssues, getRecentFeedback,
  getCommunityBreakdown, insertSentiment, deleteByMessageId, cleanOldRecords,
} = require("./database");
const { buildTelegramReport, buildWeeklyDigestTelegram } = require("./reporter");
const { analyzeSentiment } = require("./sentiment");
const { classifyMessage, isSpam } = require("./classifier");

const TG_TOKEN          = process.env.TELEGRAM_TOKEN;
const TG_REPORT_CHAT_ID = process.env.TELEGRAM_REPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

// Groups to MONITOR only — never the report chat
const TG_MONITOR_1 = process.env.TELEGRAM_CHAT_ID;
const TG_MONITOR_2 = process.env.TELEGRAM_CHAT_ID_2;
const COMMUNITY_1  = process.env.TG_COMMUNITY_NAME   || "Orderly Telegram Community";
const COMMUNITY_2  = process.env.TG_COMMUNITY_NAME_2 || "Orderly Trading Competition";

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
      res.on("data", chunk => raw += chunk);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(chat_id, text) {
  try {
    await tgRequest("sendMessage", { chat_id, text, parse_mode: "Markdown" });
  } catch {
    await tgRequest("sendMessage", { chat_id, text: text.replace(/[*`_[\]()~>#+=|{}.!-]/g, "\\$&") });
  }
}

// ─── 30-Second Delay Queue ────────────────────────────────────────────────────
// Hold messages 30s before saving — admin delete in that window = never tracked
const TRACK_DELAY_MS = 30 * 1000;
const pendingTgMsgs  = new Map(); // "chatId:messageId" → timeout

async function trackTelegramMessage(msg) {
  if (!msg?.text) return;
  if (msg.text.startsWith("/")) return;

  const text = msg.text.trim();
  if (text.length < 5) return;

  const stripped = text.replace(/https?:\/\/\S+/g, "").trim();
  if (stripped.length < 5) return;

  // Skip spam messages entirely — never track them
  if (isSpam(stripped)) {
    console.log(`🚫 Spam detected from ${msg.from?.username || "unknown"}, skipping`);
    return;
  }

  const chatId    = String(msg.chat?.id);
  const community = CHAT_COMMUNITY_MAP[chatId] || `telegram_${chatId}`;
  const msgKey    = `${chatId}:${msg.message_id}`;

  // Detect topic/sub-group name
  // Messages in a topic have message_thread_id and forum_topic_created or reply_to_message
  const topicName = msg.reply_to_message?.forum_topic_created?.name  // topic messages reference the topic creation
                 || msg.forum_topic_created?.name                      // the topic creation message itself
                 || null;

  // Use topic name as channel if available, otherwise fall back to group title
  const channelName = topicName
    ? `${msg.chat?.title || community} › ${topicName}`
    : (msg.chat?.title || community);

  const { score, label } = analyzeSentiment(stripped);
  const category         = classifyMessage(stripped);

  const payload = {
    message_id:   String(msg.message_id),
    user_id:      String(msg.from?.id || "unknown"),
    username:     msg.from?.username || msg.from?.first_name || "unknown",
    channel_id:   msg.message_thread_id ? `${chatId}_${msg.message_thread_id}` : chatId,
    channel_name: channelName,
    score, label, category,
    message_text: stripped.slice(0, 1000),
    community,
    platform: "telegram",
  };

  const timeout = setTimeout(async () => {
    pendingTgMsgs.delete(msgKey);
    try {
      await insertSentiment(payload);
      console.log(`📨 Tracked [${community}${topicName ? ` › ${topicName}` : ""}] ${label} (${category}) from ${payload.username}`);
    } catch (err) {
      console.error("❌ Failed to track Telegram message:", err.message);
    }
  }, TRACK_DELAY_MS);

  pendingTgMsgs.set(msgKey, timeout);
}

// ─── Command Handlers ─────────────────────────────────────────────────────────
async function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text || "").toLowerCase();

  try {
    if (text.startsWith("/report")) {
      await sendMessage(chatId, "⏳ Generating combined report...");
      await sendMessage(chatId, await buildTelegramReport());

    } else if (text.startsWith("/weeklyreport")) {
      await sendMessage(chatId, "⏳ Generating weekly digest...");
      await sendMessage(chatId, await buildWeeklyDigestTelegram());

    } else if (text.startsWith("/sentiment")) {
      const days    = parseInt(text.split(" ")[1]) || 7;
      const summary = await getSummary(days);
      const trend   = await getTrend(days);
      if (!summary.length) return sendMessage(chatId, "📭 No sentiment data yet.");

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
        `📊 *Combined Sentiment — Last ${days} Day${days > 1 ? "s" : ""}*\n\n*Breakdown:*\n${summaryText}\n*Trend:*\n${trendText || "Not enough data yet."}`
      );

    } else if (text.startsWith("/channels")) {
      const days      = parseInt(text.split(" ")[1]) || 1;
      const breakdown = await getChannelBreakdown(days);
      if (!breakdown.length) return sendMessage(chatId, "📭 No channel data yet.");
      const channelText = breakdown.map(({ community, channel_name, platform, avg_score, message_count }) => {
        const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        const plat = platform === "telegram" ? "📱" : "💬";
        return `${mood}${plat} *${community}/#${channel_name}* — \`${avg_score.toFixed(3)}\` · ${message_count} msgs`;
      }).join("\n");
      await sendMessage(chatId, `📡 *Channel Sentiment — Last ${days} Day${days > 1 ? "s" : ""}*\n\n${channelText}`);

    } else if (text.startsWith("/issues")) {
      const days   = parseInt(text.split(" ")[1]) || 1;
      const issues = await getRecentIssues(days, 10);
      if (!issues.length) return sendMessage(chatId, `✅ No issues in the last ${days} day${days > 1 ? "s" : ""}!`);
      const issueText = issues.map(({ username, community, platform, message_id, message_text }) => {
        const plat   = platform === "telegram" ? "📱" : "💬";
        const idLine = platform === "telegram"
          ? `\n🆔 \`/tgdelete ${message_id}\``
          : `\n🆔 \`/delete ${message_id}\``;
        return `🔴${plat} *${username}* \\[${community}\\]:\n_${message_text?.slice(0, 200)}${message_text?.length > 200 ? "..." : ""}_${idLine}`;
      }).join("\n\n");
      await sendMessage(chatId, `🐛 *Issues — Last ${days} Day${days > 1 ? "s" : ""}* (${issues.length} found)\n\n${issueText}`);

    } else if (text.startsWith("/feedback")) {
      const days     = parseInt(text.split(" ")[1]) || 1;
      const feedback = await getRecentFeedback(days, 10);
      if (!feedback.length) return sendMessage(chatId, `📭 No feedback in the last ${days} day${days > 1 ? "s" : ""}.`);
      const feedbackText = feedback.map(({ username, community, platform, message_id, message_text }) => {
        const plat   = platform === "telegram" ? "📱" : "💬";
        const idLine = platform === "telegram"
          ? `\n🆔 \`/tgdelete ${message_id}\``
          : `\n🆔 \`/delete ${message_id}\``;
        return `💬${plat} *${username}* \\[${community}\\]:\n_${message_text?.slice(0, 200)}${message_text?.length > 200 ? "..." : ""}_${idLine}`;
      }).join("\n\n");
      await sendMessage(chatId, `💡 *Feedback — Last ${days} Day${days > 1 ? "s" : ""}* (${feedback.length} found)\n\n${feedbackText}`);

    } else if (text.startsWith("/communities")) {
      const breakdown = await getCommunityBreakdown(7);
      if (!breakdown.length) return sendMessage(chatId, "📭 No community data yet.");
      const comText = breakdown.map(({ community, platform, message_count, avg_score, positive_count, negative_count }) => {
        const plat = platform === "telegram" ? "📱" : "💬";
        const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        return `${mood}${plat} *${community}*\n   ${message_count} msgs · avg: \`${avg_score.toFixed(3)}\` · 😊${positive_count} 😠${negative_count}`;
      }).join("\n\n");
      await sendMessage(chatId, `🌐 *Community Breakdown — Last 7 Days*\n\n${comText}`);

    } else if (text.startsWith("/tgdeleteuser")) {
      const parts    = text.split(" ");
      const username = parts[1]?.replace("@", "").trim();
      const days     = parseInt(parts[2]) || 1;
      if (!username) {
        return sendMessage(chatId,
          `⚠️ Usage: \`/tgdeleteuser <username> [days]\`\n\nExample: \`/tgdeleteuser abhinayxsingh 7\`\nDeletes all issue/feedback records from that user in the last N days (default: 1 day).`
        );
      }
      const { deleteByUsername } = require("./database");
      const removed = await deleteByUsername(username, days);
      if (!removed.length) {
        return sendMessage(chatId, `⚠️ No records found for *${username}* in the last ${days} day${days > 1 ? "s" : ""}.`);
      }
      await sendMessage(chatId,
        `✅ Deleted *${removed.length}* record${removed.length > 1 ? "s" : ""} from *${username}*:\n` +
        removed.map(r => `🗑️ ${r.category}: _${r.message_text?.slice(0, 60)}..._`).join("\n")
      );

    } else if (text.startsWith("/tgdelete")) {
      const messageId = text.split(" ")[1]?.trim();
      if (!messageId) return sendMessage(chatId, "⚠️ Usage: `/tgdelete <message_id>`");
      // Cancel if still pending
      const msgKey = `${chatId}:${messageId}`;
      if (pendingTgMsgs.has(msgKey)) {
        clearTimeout(pendingTgMsgs.get(msgKey));
        pendingTgMsgs.delete(msgKey);
        return sendMessage(chatId, `✅ Cancelled pending message \`${messageId}\` — never saved to DB.`);
      }
      const removed = await deleteByMessageId(messageId);
      if (!removed) return sendMessage(chatId, `⚠️ No record found for message ID \`${messageId}\`.`);
      await sendMessage(chatId, `✅ Removed:\nID: \`${messageId}\`\nCategory: *${removed.category}*\nTracked at: \`${new Date(removed.timestamp).toLocaleString()}\``);

    } else if (text.startsWith("/tgfind")) {
      // Usage: /tgfind <username>
      const username = text.split(" ").slice(1).join(" ").trim();
      if (!username) return sendMessage(chatId, "⚠️ Usage: `/tgfind <username>`");

      const { pool } = require("./database");
      const { rows } = await pool.query(`
        SELECT username, category, message_id, message_text, timestamp
        FROM sentiment
        WHERE username ILIKE $1
          AND category IN ('issue','feedback')
        ORDER BY timestamp DESC LIMIT 10
      `, [`%${username}%`]);

      if (!rows.length) return sendMessage(chatId, `📭 No records found matching *${username}*`);

      const result = rows.map(r =>
        `👤 *${r.username}* | ${r.category}\n` +
        `🆔 \`${r.message_id || "no-id"}\`\n` +
        `📅 ${new Date(r.timestamp).toLocaleDateString()}\n` +
        `💬 _${r.message_text?.slice(0, 60)}..._`
      ).join("\n\n");

      await sendMessage(chatId, `🔍 *Records matching "${username}":*\n\n${result}`);

    } else if (text.startsWith("/tgclean")) {
      const { before, deleted } = await cleanOldRecords();
      const beforeText = before.map(({ category, total, no_id }) =>
        `*${category}*: ${total} total, ${no_id} with no ID`
      ).join("\n") || "No issue/feedback records.";
      await sendMessage(chatId, `🧹 *Database Cleanup*\n\n*Before:*\n${beforeText}\n\n🗑️ Deleted *${deleted}* unverifiable records.`);

    } else if (text.startsWith("/tgtrack")) {
      // Usage: /tgtrack issue|feedback <message text>
      const parts    = text.split(" ");
      const category = parts[1]?.toLowerCase();
      const msgText  = parts.slice(2).join(" ").trim();

      if (!category || !["issue", "feedback"].includes(category) || !msgText) {
        return sendMessage(chatId,
          `⚠️ Usage: \`/tgtrack <issue|feedback> <message text>\`\n\n` +
          `Example:\n\`/tgtrack issue User reported BTC leverage resets when changing CAKE\``
        );
      }

      const { analyzeSentiment } = require("./sentiment");
      const { insertSentiment }  = require("./database");
      const { score, label }     = analyzeSentiment(msgText);
      const community            = CHAT_COMMUNITY_MAP[String(chatId)] || "telegram_manual";

      await insertSentiment({
        message_id:   `manual_${Date.now()}`,
        user_id:      String(msg.from?.id || "manual"),
        username:     msg.from?.username || msg.from?.first_name || "admin",
        channel_id:   String(chatId),
        channel_name: msg.chat?.title || community,
        score, label, category,
        message_text: msgText.slice(0, 1000),
        community,
        platform: "telegram",
      });

      const catEmoji = category === "issue" ? "🐛" : "💡";
      await sendMessage(chatId,
        `✅ Manually tracked as *${category}*:\n${catEmoji} ${msgText.slice(0, 200)}${msgText.length > 200 ? "..." : ""}`
      );

    } else if (text.startsWith("/start") || text.startsWith("/help")) {
      await sendMessage(chatId,
        `👋 *Sentiment Bot*\n\nTracking sentiment across all your communities.\n\n` +
        `*Commands:*\n` +
        `/report — Daily report\n` +
        `/weeklyreport — Weekly digest\n` +
        `/sentiment \\[days\\] — Sentiment summary\n` +
        `/channels \\[days\\] — Per\\-channel breakdown\n` +
        `/issues \\[days\\] — Recent issues\n` +
        `/feedback \\[days\\] — Recent feedback\n` +
        `/communities — All communities overview\n` +
        `/tgtrack \\[issue|feedback\\] \\[text\\] — Manually track a message \\(admin\\)\n` +
        `/tgdelete \\[id\\] — Remove by message ID \\(admin\\)\n` +
        `/tgdeleteuser \\[username\\] \\[days\\] — Remove all records from a user \\(admin\\)\n` +
        `/tgclean — Clean unverifiable records \\(admin\\)\n` +
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
    const res = await tgRequest("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });

    if (res.ok && res.result.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;

        if (msg.text?.startsWith("/")) {
          await handleCommand(msg);
        } else {
          // Only track from monitored groups — NEVER from report chat
          const msgChatId   = String(msg.chat?.id);
          const isMonitored = msgChatId === String(TG_MONITOR_1) || msgChatId === String(TG_MONITOR_2);
          if (isMonitored) await trackTelegramMessage(msg);
        }
      }
    }
  } catch (err) {
    const isNormal = err.message?.includes("socket hang up") ||
                     err.message?.includes("ECONNRESET") ||
                     err.message?.includes("ETIMEDOUT");
    if (!isNormal) console.error("❌ Telegram poll error:", err.message);
    await new Promise(r => setTimeout(r, 3000));
  }
  setImmediate(poll);
}

// ─── Daily Report ─────────────────────────────────────────────────────────────
async function sendTelegramDailyReport() {
  if (!TG_REPORT_CHAT_ID) { console.warn("⚠️  No TELEGRAM_REPORT_CHAT_ID set — skipping."); return; }
  try {
    await sendMessage(TG_REPORT_CHAT_ID, await buildTelegramReport());
    console.log("✅ Telegram daily report sent.");
  } catch (err) { console.error("❌ Failed to send Telegram report:", err.message); }
}

// ─── Start ────────────────────────────────────────────────────────────────────
function startTelegramBot() {
  if (!TG_TOKEN) { console.warn("⚠️  TELEGRAM_TOKEN not set — Telegram bot disabled."); return; }
  console.log("🤖 Telegram bot started");
  if (TG_MONITOR_1)      console.log(`   📊 Monitoring: ${COMMUNITY_1} (${TG_MONITOR_1})`);
  if (TG_MONITOR_2)      console.log(`   📊 Monitoring: ${COMMUNITY_2} (${TG_MONITOR_2})`);
  if (TG_REPORT_CHAT_ID) console.log(`   📬 Reports to: ${TG_REPORT_CHAT_ID}`);
  poll();
}

module.exports = { startTelegramBot, sendTelegramDailyReport, sendTelegramMessage: sendMessage };