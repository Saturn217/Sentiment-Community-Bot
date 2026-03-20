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
      try {
        const parts = await buildWeeklyDigestTelegram();
        for (let i = 0; i < parts.length; i++) {
          try {
            await sendMessage(chatId, parts[i]);
          } catch (partErr) {
            console.error(`❌ Weekly digest part ${i + 1} failed:`, partErr.message);
            // Send plain text fallback if Markdown fails
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: parts[i].replace(/[*_`[\]()~>#+=|{}.!\\-]/g, ""),
            });
          }
        }
      } catch (err) {
        console.error("❌ Weekly digest build failed:", err.message);
        await sendMessage(chatId, "⚠️ Failed to generate weekly digest. Check logs.");
      }

    } else if (text.startsWith("/sentiment")) {
      const days    = parseInt(text.split(" ")[1]) || 7;
      const summary = await getSummary(days);
      const trend   = await getTrend(days);
      if (!summary.length) return sendMessage(chatId, "📭 No sentiment data yet.");

      let totalMsgs = 0, weightedScore = 0, summaryText = "";
      summary.forEach(({ label, count, avg_score }) => {
        const emoji = label === "positive" ? "🟢" : label === "negative" ? "🔴" : "🟡";
        const pct   = 0; // calculated after
        summaryText += `${emoji} *${label}*: ${count} msgs\n`;
        totalMsgs += count; weightedScore += avg_score * count;
      });

      // Add percentages now that we have totalMsgs
      summaryText = "";
      summary.forEach(({ label, count }) => {
        const emoji = label === "positive" ? "🟢" : label === "negative" ? "🔴" : "🟡";
        const pct   = totalMsgs > 0 ? Math.round((count / totalMsgs) * 100) : 0;
        summaryText += `${emoji} *${label}*: ${count} msgs (${pct}%)\n`;
      });

      const overall     = totalMsgs > 0 ? weightedScore / totalMsgs : 0;
      const overallWord = overall > 0.3 ? "🔥 Very happy" : overall > 0.1 ? "😄 Happy" : overall > 0.02 ? "🙂 Mostly positive" : overall > -0.02 ? "😐 Mixed / neutral" : overall > -0.1 ? "😕 A bit negative" : overall > -0.3 ? "😠 Unhappy" : "🚨 Very unhappy";

      let trendText = "";
      trend.slice(-7).forEach(({ date, avg_score, message_count }) => {
        const arrow = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
        const short = new Date(date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        const words = avg_score > 0.3 ? "Very happy" : avg_score > 0.1 ? "Happy" : avg_score > 0.02 ? "Mostly positive" : avg_score > -0.02 ? "Mixed" : avg_score > -0.1 ? "A bit negative" : avg_score > -0.3 ? "Unhappy" : "Very unhappy";
        trendText += `${arrow} *${short}* — ${words} · ${message_count} msgs\n`;
      });

      await sendMessage(chatId,
        `📊 *Combined Sentiment — Last ${days} Day${days > 1 ? "s" : ""}*\n\n` +
        `*Overall mood:* ${overallWord}\n` +
        `*Total messages:* ${totalMsgs}\n\n` +
        `*Breakdown:*\n${summaryText}\n` +
        `*Trend:*\n${trendText || "Not enough data yet."}`
      );

    } else if (text.startsWith("/channels")) {
      const days      = parseInt(text.split(" ")[1]) || 1;
      const breakdown = await getChannelBreakdown(days);
      if (!breakdown.length) return sendMessage(chatId, "📭 No channel data yet.");
      const channelText = breakdown.map(({ community, channel_name, platform, avg_score, message_count }) => {
        const mood  = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        const plat  = platform === "telegram" ? "📱" : "💬";
        const words = avg_score > 0.3 ? "Very happy" : avg_score > 0.1 ? "Happy" : avg_score > 0.02 ? "Mostly positive" : avg_score > -0.02 ? "Mixed" : avg_score > -0.1 ? "A bit negative" : "Unhappy";
        return `${mood}${plat} *${community}/#${channel_name}* — ${words} · ${message_count} msgs`;
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
        const plat  = platform === "telegram" ? "📱" : "💬";
        const mood  = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        const words = avg_score > 0.3 ? "Very happy" : avg_score > 0.1 ? "Happy" : avg_score > 0.02 ? "Mostly positive" : avg_score > -0.02 ? "Mixed" : avg_score > -0.1 ? "A bit negative" : "Unhappy";
        return `${mood}${plat} *${community}*\n   ${message_count} msgs · ${words} · 😊${positive_count} 😠${negative_count}`;
      }).join("\n\n");
      await sendMessage(chatId, `🌐 *Community Breakdown — Last 7 Days*\n\n${comText}`);

    } else if (text.startsWith("/pausereport")) {
      const parts = text.split(" ");
      const type  = parts[1]?.toLowerCase();
      const times = parseInt(parts[2]) || null;

      if (!type || !["daily", "weekly", "both"].includes(type)) {
        return sendMessage(chatId,
          `⚠️ Usage: \`/pausereport <daily|weekly|both> [times]\`\n\n` +
          `Examples:\n` +
          `\`/pausereport daily 1\` — skip tomorrow's report only\n` +
          `\`/pausereport both 2\` — skip next 2 reports\n` +
          `\`/pausereport daily\` — pause indefinitely`
        );
      }

      const { reportState } = require("./bot");
      if (type === "daily"  || type === "both") { reportState.dailyPaused  = true; reportState.dailySkipCount  = times || 0; reportState.dailyPausedUntil  = null; }
      if (type === "weekly" || type === "both") { reportState.weeklyPaused = true; reportState.weeklySkipCount = times || 0; reportState.weeklyPausedUntil = null; }

      const typeLabel  = type === "both" ? "Daily \\+ Weekly" : type === "daily" ? "Daily report" : "Weekly digest";
      const timesLabel = times ? `for next *${times}* report${times > 1 ? "s" : ""} \\(auto\\-resumes after\\)` : "indefinitely";
      await sendMessage(chatId, `⏸️ *${typeLabel}* paused ${timesLabel}\\.\nUse /resumereport to turn back on early\\.`);

    } else if (text.startsWith("/resumereport")) {
      const type = text.split(" ")[1]?.toLowerCase();

      if (!type || !["daily", "weekly", "both"].includes(type)) {
        return sendMessage(chatId, `⚠️ Usage: \`/resumereport <daily|weekly|both>\``);
      }

      const { reportState } = require("./bot");
      if (type === "daily"  || type === "both") { reportState.dailyPaused  = false; reportState.dailyPausedUntil  = null; }
      if (type === "weekly" || type === "both") { reportState.weeklyPaused = false; reportState.weeklyPausedUntil = null; }

      const typeLabel = type === "both" ? "Daily \\+ Weekly reports" : type === "daily" ? "Daily report" : "Weekly digest";
      await sendMessage(chatId, `▶️ *${typeLabel}* resumed\\. Reports will send at their next scheduled time\\.`);

    } else if (text.startsWith("/reportstatus")) {
      const { reportState } = require("./bot");

      const dailyStatus  = reportState.dailyPaused
        ? `⏸️ Paused${reportState.dailySkipCount > 0 ? ` — ${reportState.dailySkipCount} report${reportState.dailySkipCount !== 1 ? "s" : ""} left to skip` : " indefinitely"}`
        : "▶️ Running";
      const weeklyStatus = reportState.weeklyPaused
        ? `⏸️ Paused${reportState.weeklySkipCount > 0 ? ` — ${reportState.weeklySkipCount} report${reportState.weeklySkipCount !== 1 ? "s" : ""} left to skip` : " indefinitely"}`
        : "▶️ Running";

      await sendMessage(chatId,
        `📊 *Report Status*\n\n` +
        `📅 Daily report: ${dailyStatus}\n` +
        `📋 Weekly digest: ${weeklyStatus}\n\n` +
        `_Both Discord and Telegram share the same status\\._`
      );

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
        `*Report Commands:*\n` +
        `/report — Daily report\n` +
        `/weeklyreport — Weekly digest\n` +
        `/pausereport \\[daily|weekly|both\\] \\[days\\] — Pause reports \\(admin\\)\n` +
        `/resumereport \\[daily|weekly|both\\] — Resume reports \\(admin\\)\n` +
        `/reportstatus — Check if reports are paused \\(admin\\)\n\n` +
        `*Analytics Commands:*\n` +
        `/sentiment \\[days\\] — Sentiment summary\n` +
        `/channels \\[days\\] — Per\\-channel breakdown\n` +
        `/issues \\[days\\] — Recent issues\n` +
        `/feedback \\[days\\] — Recent feedback\n` +
        `/communities — All communities overview\n\n` +
        `*Admin Commands:*\n` +
        `/tgtrack \\[issue|feedback\\] \\[text\\] — Manually track a message\n` +
        `/tgdelete \\[id\\] — Remove by message ID\n` +
        `/tgdeleteuser \\[username\\] \\[days\\] — Remove all records from a user\n` +
        `/tgclean — Clean unverifiable records\n` +
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