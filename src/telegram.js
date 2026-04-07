const https = require("https");
const Anthropic = require("@anthropic-ai/sdk");
const {
  getSummary, getTrend, getChannelBreakdown, getRecentIssues, getRecentFeedback,
  getCommunityBreakdown, insertSentiment, deleteByMessageId, cleanOldRecords,
  getCategorySummary, deleteAllByUser,
  getConversationHistory, saveConversationTurn, clearConversationHistory,
} = require("./database");
const { rescheduleDailyCron } = require("./scheduler");
const { buildTelegramReport, buildWeeklyDigestTelegram } = require("./reporter");
const { analyzeSentiment } = require("./sentiment");
const { classifyMessageAI, isSpam } = require("./classifier");

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

// ─── Claude Agent Setup ───────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Docs Cache ───────────────────────────────────────────────────────────────
// Set AGENT_DOCS_URL in your .env to any public URL (docs site, Notion, GitHub
// README, etc). It gets fetched once at startup and injected into every prompt.
let cachedDocs = "";

async function fetchAndCacheDocs() {
  const docsUrl = process.env.AGENT_DOCS_URL;
  if (!docsUrl) return;

  try {
    console.log(`📖 Fetching docs from ${docsUrl}...`);
    const content = await fetchUrl(docsUrl, 3);

    // Strip HTML tags — keep readable plain text only
    cachedDocs = content
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
      .replace(/\s{3,}/g, "\n\n")
      .trim()
      .slice(0, 8000); // cap at 8000 chars to stay within Claude's token limit

    console.log(`✅ Docs cached (${cachedDocs.length} chars)`);
  } catch (err) {
    console.warn("⚠️  Could not fetch docs:", err.message);
  }
}

// Simple HTTP/HTTPS GET with redirect following
function fetchUrl(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("https") ? require("https") : require("http");
    lib.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(fetchUrl(res.headers.location, redirectsLeft - 1));
      }
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => resolve(raw));
    }).on("error", reject);
  });
}

// Bot's own username — fetched from Telegram on startup, used to detect @mentions
let BOT_USERNAME = "";

// Per-chat conversation history — persisted in agent_conversations DB table.
// Survives restarts. Each chat keeps up to 20 messages (10 turns).

async function getHistory(chatId) {
  try {
    return await getConversationHistory(chatId);
  } catch (err) {
    console.error("❌ Failed to load conversation history:", err.message);
    return [];
  }
}

async function pushHistory(chatId, role, content) {
  try {
    await saveConversationTurn(chatId, role, content);
  } catch (err) {
    console.error("❌ Failed to save conversation turn:", err.message);
  }
}

/**
 * Fetch live community data from the DB and format it as a readable
 * context block that gets injected into Claude's system prompt.
 * This is what makes Claude aware of real-time sentiment, issues and feedback.
 */
async function buildLiveContext() {
  try {
    const [
      summary,
      communities,
      recentIssues,
      recentFeedback,
      trend,
      channels,
    ] = await Promise.all([
      getSummary(30),
      getCommunityBreakdown(30),
      getRecentIssues(30, 15),
      getRecentFeedback(30, 15),
      getTrend(30),
      getChannelBreakdown(1),
    ]);

    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });

    // ── Overall sentiment last 7 days ──────────────────────────────────────
    let totalMsgs = 0, weightedScore = 0;
    const labelCounts = {};
    summary.forEach(({ label, count, avg_score }) => {
      totalMsgs += count;
      weightedScore += avg_score * count;
      labelCounts[label] = count;
    });
    const overallScore = totalMsgs > 0 ? weightedScore / totalMsgs : 0;
    const overallMood  = overallScore > 0.3  ? "Very happy"
                       : overallScore > 0.1  ? "Happy"
                       : overallScore > 0.02 ? "Mostly positive"
                       : overallScore > -0.02 ? "Mixed / neutral"
                       : overallScore > -0.1  ? "A bit negative"
                       : overallScore > -0.3  ? "Unhappy"
                       : "Very unhappy";

    let ctx = `Today is ${today}.\n\n`;
    ctx += `## LIVE COMMUNITY SENTIMENT DATA (last 30 days)\n\n`;
    ctx += `**Overall mood:** ${overallMood} (score: ${overallScore.toFixed(3)})\n`;
    ctx += `**Total messages tracked:** ${totalMsgs}\n`;
    ctx += `**Positive:** ${labelCounts.positive || 0} | **Neutral:** ${labelCounts.neutral || 0} | **Negative:** ${labelCounts.negative || 0}\n\n`;

    // ── Per-community breakdown ────────────────────────────────────────────
    if (communities.length) {
      ctx += `## Community Breakdown\n`;
      communities.forEach(({ community, platform, message_count, avg_score, positive_count, negative_count, neutral_count }) => {
        const mood = avg_score > 0.05 ? "positive" : avg_score < -0.05 ? "negative" : "neutral";
        ctx += `- **${community}** (${platform}): ${message_count} msgs, mood: ${mood} (${avg_score.toFixed(3)}), 😊${positive_count} 😐${neutral_count} 😠${negative_count}\n`;
      });
      ctx += "\n";
    }

    // ── 30-day trend ──────────────────────────────────────────────────────
    if (trend.length) {
      ctx += `## Day-by-Day Trend (last 30 days)\n`;
      trend.forEach(({ date, avg_score, message_count }) => {
        const d     = new Date(date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        const arrow = avg_score > 0.05 ? "↑" : avg_score < -0.05 ? "↓" : "→";
        ctx += `- ${d}: ${arrow} score ${avg_score.toFixed(3)}, ${message_count} messages\n`;
      });
      ctx += "\n";
    }

    // ── Active channels today ─────────────────────────────────────────────
    if (channels.length) {
      ctx += `## Most Active Channels Today\n`;
      channels.forEach(({ community, channel_name, platform, avg_score, message_count }) => {
        const mood = avg_score > 0.05 ? "positive" : avg_score < -0.05 ? "negative" : "neutral";
        ctx += `- ${community}/#${channel_name} (${platform}): ${message_count} msgs, ${mood}\n`;
      });
      ctx += "\n";
    }

    // ── Recent issues ─────────────────────────────────────────────────────
    if (recentIssues.length) {
      ctx += `## Recent Issues Reported (last 30 days) — ${recentIssues.length} total\n`;
      recentIssues.forEach(({ username, community, platform, message_text, timestamp }) => {
        const when = new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        ctx += `- [${when}] **${username}** (${community}/${platform}): ${message_text?.slice(0, 200)}\n`;
      });
      ctx += "\n";
    } else {
      ctx += `## Recent Issues\nNo issues reported in the last 30 days.\n\n`;
    }

    // ── Recent feedback ───────────────────────────────────────────────────
    if (recentFeedback.length) {
      ctx += `## Recent Feedback (last 30 days) — ${recentFeedback.length} total\n`;
      recentFeedback.forEach(({ username, community, platform, message_text, timestamp }) => {
        const when = new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        ctx += `- [${when}] **${username}** (${community}/${platform}): ${message_text?.slice(0, 200)}\n`;
      });
      ctx += "\n";
    } else {
      ctx += `## Recent Feedback\nNo feedback submitted in the last 30 days.\n\n`;
    }

    return ctx;
  } catch (err) {
    console.error("❌ Failed to build live context:", err.message);
    // Return a minimal fallback so Claude still responds, just without data
    return `Today is ${new Date().toDateString()}.\nNote: Live community data could not be loaded right now.\n`;
  }
}

/**
 * Send a question to Claude with live DB context injected into the system prompt.
 * Maintains per-chat conversation history for follow-up questions.
 */
async function askClaude(chatId, userMessage) {
  const history    = await getHistory(chatId);
  const liveData   = await buildLiveContext();
  const messages   = [...history, { role: "user", content: userMessage }];

  // Inject docs (if loaded) between the persona instructions and the live data
  const docsSection = cachedDocs
    ? `## PRODUCT / COMPANY DOCUMENTATION\n${cachedDocs}\n\n`
    : "";

  const systemPrompt =
    (process.env.AGENT_SYSTEM_PROMPT ||
      "You are a helpful community intelligence assistant for this company, deployed in Telegram. " +
      "Your job is to answer questions about community sentiment, issues, and feedback across all platforms " +
      "(Discord and Telegram). Be clear and concise. Use bullet points where helpful. " +
      "When quoting specific issues or feedback, always mention the username and community they came from. " +
      "If the data doesn't answer the question, say so honestly."
    ) + "\n\n" + docsSection + liveData;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  const reply = response.content[0].text;

  // Save this turn so follow-up questions have context
  await pushHistory(chatId, "user", userMessage);
  await pushHistory(chatId, "assistant", reply);

  return reply;
}

/**
 * Strip the bot @mention from a message text so only the actual question remains.
 * e.g. "@MySentimentBot what is our refund policy?" → "what is our refund policy?"
 */
function stripMention(text) {
  if (!BOT_USERNAME) return text.trim();
  return text.replace(new RegExp(`@${BOT_USERNAME}\\s*`, "gi"), "").trim();
}

/**
 * Check whether the bot is @mentioned in a message.
 * Checks both the raw text and the entities array from Telegram.
 */
function isBotMentioned(msg) {
  if (!BOT_USERNAME) return false;
  const text     = msg.text || "";
  const entities = msg.entities || [];

  // Check entities (most reliable)
  const mentionedViaEntity = entities.some(
    e => e.type === "mention" &&
      text.substring(e.offset, e.offset + e.length).toLowerCase() ===
      `@${BOT_USERNAME.toLowerCase()}`
  );
  if (mentionedViaEntity) return true;

  // Fallback: plain text check
  return text.toLowerCase().includes(`@${BOT_USERNAME.toLowerCase()}`);
}

/**
 * Check if this message is a direct reply to one of the bot's own messages.
 */
function isReplyToBot(msg) {
  if (!BOT_USERNAME) return false;
  return msg.reply_to_message?.from?.username?.toLowerCase() ===
    BOT_USERNAME.toLowerCase();
}

/**
 * Send a "typing…" action then reply with Claude's answer.
 * Replies to the specific message so it's clear who the bot is responding to.
 */
async function replyWithClaude(chatId, query, replyToMessageId) {
  if (!query) {
    await tgRequest("sendMessage", {
      chat_id: chatId,
      text: "👋 Hi! Ask me anything.",
      reply_to_message_id: replyToMessageId,
    });
    return;
  }

  try {
    // React to the user's message to acknowledge it
    tgRequest("setMessageReaction", {
      chat_id:    chatId,
      message_id: replyToMessageId,
      reaction:   [{ type: "emoji", emoji: "👀" }],
    }).catch(() => {});

    // Show typing indicator while Claude thinks
    await tgRequest("sendChatAction", { chat_id: chatId, action: "typing" });

    const answer = await askClaude(String(chatId), query);

    // Try Markdown first, fall back to plain text if it fails
    try {
      await tgRequest("sendMessage", {
        chat_id:             chatId,
        text:                answer,
        parse_mode:          "Markdown",
        reply_to_message_id: replyToMessageId,
      });
    } catch {
      await tgRequest("sendMessage", {
        chat_id:             chatId,
        text:                answer.replace(/[*`_[\]()~>#+=|{}.!-]/g, "\\$&"),
        reply_to_message_id: replyToMessageId,
      });
    }
  } catch (err) {
    console.error("❌ Claude agent error:", err.message);
    await tgRequest("sendMessage", {
      chat_id:             chatId,
      text:                "⚠️ Sorry, I ran into an error. Please try again.",
      reply_to_message_id: replyToMessageId,
    });
  }
}

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
  const topicName = msg.reply_to_message?.forum_topic_created?.name
                 || msg.forum_topic_created?.name
                 || null;

  const channelName = topicName
    ? `${msg.chat?.title || community} › ${topicName}`
    : (msg.chat?.title || community);

  const { score, label } = analyzeSentiment(stripped);
  const category         = await classifyMessageAI(stripped);

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

    // ── NEW: /ask — explicit agent command ───────────────────────────────────
    if (text.startsWith("/ask")) {
      const query = msg.text.slice(4).trim(); // preserve original casing
      if (!query) {
        return sendMessage(chatId,
          `💡 Usage: \`/ask <your question>\`\n\nYou can also just tag me: \`@${BOT_USERNAME} your question\``
        );
      }
      return replyWithClaude(chatId, query, msg.message_id);

    // ── /clearchat — reset conversation memory ───────────────────────────────
    } else if (text.startsWith("/clearchat")) {
      await clearConversationHistory(String(chatId));
      return sendMessage(chatId, "🧹 Conversation history cleared! Starting fresh.");

    // ── /setreporttime HH:MM — change daily report schedule ─────────────────
    } else if (text.startsWith("/setreporttime")) {
      const timeArg = text.split(" ")[1]?.trim();
      const match   = timeArg?.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) {
        return sendMessage(chatId,
          `⚠️ Usage: \`/setreporttime HH:MM\`\n\nExample: \`/setreporttime 10:30\`\nSets the daily report to fire at 10:30 AM UTC.`
        );
      }
      const hour = parseInt(match[1], 10);
      const min  = parseInt(match[2], 10);
      if (hour > 23 || min > 59) {
        return sendMessage(chatId, "⚠️ Invalid time. Hours must be 0–23, minutes 0–59.");
      }
      const cronExpr = `${min} ${hour} * * *`;
      const ok = await rescheduleDailyCron(cronExpr);
      if (ok) {
        return sendMessage(chatId,
          `✅ Daily report rescheduled to *${String(hour).padStart(2,"0")}:${String(min).padStart(2,"0")} UTC*.\n_Next report fires tomorrow at that time._`
        );
      }
      return sendMessage(chatId, "⚠️ Could not reschedule — bot may still be starting up. Try again in a moment.");

    } else if (text.startsWith("/report")) {
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

      let totalMsgs = 0, weightedScore = 0;
      summary.forEach(({ count, avg_score }) => { totalMsgs += count; weightedScore += avg_score * count; });

      let summaryText = "";
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

      const { reportState } = require("./reportState");
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

      const { reportState } = require("./reportState");
      if (type === "daily"  || type === "both") { reportState.dailyPaused  = false; reportState.dailyPausedUntil  = null; }
      if (type === "weekly" || type === "both") { reportState.weeklyPaused = false; reportState.weeklyPausedUntil = null; }

      const typeLabel = type === "both" ? "Daily \\+ Weekly reports" : type === "daily" ? "Daily report" : "Weekly digest";
      await sendMessage(chatId, `▶️ *${typeLabel}* resumed\\. Reports will send at their next scheduled time\\.`);

    } else if (text.startsWith("/reportstatus")) {
      const { reportState } = require("./reportState");

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
        `👋 *Sentiment Bot + AI Agent*\n\n` +
        `I track community sentiment AND answer questions via Claude AI\\.\n\n` +
        `*🤖 Agent — Ask Me Anything:*\n` +
        `Tag me in a group: \`@${BOT_USERNAME} your question\`\n` +
        `/ask \\[question\\] — Ask me directly\n` +
        `/clearchat — Reset our conversation memory\n\n` +
        `*📊 Report Commands:*\n` +
        `/report — Daily report\n` +
        `/weeklyreport — Weekly digest\n` +
        `/setreporttime \\[HH:MM\\] — Change daily report time\n` +
        `/pausereport \\[daily|weekly|both\\] \\[days\\]\n` +
        `/resumereport \\[daily|weekly|both\\]\n` +
        `/reportstatus — Check report pause status\n\n` +
        `*📈 Analytics Commands:*\n` +
        `/sentiment \\[days\\] — Sentiment summary\n` +
        `/channels \\[days\\] — Per\\-channel breakdown\n` +
        `/issues \\[days\\] — Recent issues\n` +
        `/feedback \\[days\\] — Recent feedback\n` +
        `/communities — All communities overview\n\n` +
        `*🔧 Admin Commands:*\n` +
        `/tgtrack \\[issue|feedback\\] \\[text\\]\n` +
        `/tgdelete \\[id\\]\n` +
        `/tgdeleteuser \\[username\\] \\[days\\]\n` +
        `/tgclean — Clean unverifiable records`
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
    const res = await tgRequest("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "chat_member"] });

    if (res.ok && res.result.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;

        // ── Auto-purge on ban ─────────────────────────────────────────────────
        if (update.chat_member) {
          const { new_chat_member } = update.chat_member;
          if (new_chat_member?.status === "kicked") {
            const banned = new_chat_member.user;
            const username = banned.username || banned.first_name || "unknown";
            const deleted  = await deleteAllByUser(username, banned.id).catch(() => 0);
            if (deleted > 0)
              console.log(`🚫 Banned user @${username} — purged ${deleted} tracked record(s) from DB`);
          }
          continue;
        }

        const msg = update.message;
        if (!msg) continue;

        const msgChatId  = String(msg.chat?.id);
        const isPrivate  = msg.chat?.type === "private";
        const isMonitored = msgChatId === String(TG_MONITOR_1) || msgChatId === String(TG_MONITOR_2);

        // ── Slash commands — always handled ──────────────────────────────────
        if (msg.text?.startsWith("/")) {
          await handleCommand(msg);
          continue;
        }

        // ── Agent: DMs — respond to everything ───────────────────────────────
        if (isPrivate) {
          const query = (msg.text || "").trim();
          await replyWithClaude(msgChatId, query, msg.message_id);
          continue;
        }

        // ── Agent: Groups — respond only when mentioned or replied to ────────
        if (isBotMentioned(msg) || isReplyToBot(msg)) {
          const query = stripMention(msg.text || "").trim();
          await replyWithClaude(msgChatId, query, msg.message_id);
          // Still track sentiment for the message (don't skip)
          if (isMonitored) await trackTelegramMessage(msg);
          continue;
        }

        // ── Sentiment tracking (unchanged existing behaviour) ─────────────────
        if (isMonitored) await trackTelegramMessage(msg);
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
async function startTelegramBot() {
  if (!TG_TOKEN) { console.warn("⚠️  TELEGRAM_TOKEN not set — Telegram bot disabled."); return; }

  // Fetch the bot's own username so we can detect @mentions
  try {
    const me = await tgRequest("getMe", {});
    if (me.ok) {
      BOT_USERNAME = me.result.username;
      console.log(`🤖 Telegram bot started as @${BOT_USERNAME}`);
    }
  } catch (err) {
    console.warn("⚠️  Could not fetch bot username:", err.message);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️  ANTHROPIC_API_KEY not set — agent replies will fail.");
  } else {
    console.log("🧠 Claude agent ready");
  }

  if (TG_MONITOR_1)      console.log(`   📊 Monitoring: ${COMMUNITY_1} (${TG_MONITOR_1})`);
  if (TG_MONITOR_2)      console.log(`   📊 Monitoring: ${COMMUNITY_2} (${TG_MONITOR_2})`);
  if (TG_REPORT_CHAT_ID) console.log(`   📬 Reports to: ${TG_REPORT_CHAT_ID}`);

  // Fetch and cache docs on startup (non-blocking)
  fetchAndCacheDocs();

  poll();
}

module.exports = { startTelegramBot, sendTelegramDailyReport, sendTelegramMessage: sendMessage };