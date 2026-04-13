if (process.env.NODE_ENV !== "production") require("dotenv").config();

const { Client, GatewayIntentBits, REST, Routes, Collection, EmbedBuilder } = require("discord.js");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const cron  = require("node-cron");

const { analyzeSentiment }                                             = require("./sentiment");
const { classifyMessageAI, loadCustomKeywords, isSpam }                = require("./classifier");
const { initDB, insertSentiment, deleteByMessageId, deleteAllByUser, getDashboardData,
        detectSentimentSpike, detectIssueSurge, getSetting, setSetting } = require("./database");
const { registerReschedule } = require("./scheduler");
const { sendDailyReport, sendWeeklyDigest, buildWeeklyDigestTelegram } = require("./reporter");
const { startTelegramBot, sendTelegramDailyReport, sendTelegramMessage } = require("./telegram");
const { reportState, isReportPaused, consumeSkip }                    = require("./reportState");
const commands = require("./commands");

// ─── Community Config ─────────────────────────────────────────────────────────
const COMMUNITY_MAP = {
  [process.env.GUILD_ID]:   process.env.COMMUNITY_NAME   || "discord_main",
  [process.env.GUILD_ID_2]: process.env.COMMUNITY_NAME_2 || "discord_secondary",
};

console.log("ENV CHECK:", {
  hasToken:     !!process.env.DISCORD_TOKEN,
  hasClientId:  !!process.env.CLIENT_ID,
  hasGuildId:   !!process.env.GUILD_ID,
  hasChannel:   !!process.env.REPORT_CHANNEL_ID,
  hasDatabase:  !!process.env.DATABASE_URL,
  hasTelegram:  !!process.env.TELEGRAM_TOKEN,
  hasTgChatId:  !!process.env.TELEGRAM_CHAT_ID,
  hasTgChatId2: !!process.env.TELEGRAM_CHAT_ID_2,
  hasTgReport:  !!process.env.TELEGRAM_REPORT_CHAT_ID,
  nodeEnv:      process.env.NODE_ENV,
});

const IGNORED_CHANNELS = process.env.IGNORED_CHANNELS
  ? process.env.IGNORED_CHANNELS.split(",").map(id => id.trim())
  : [];

// ─── Client Setup ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans,
  ],
});

client.commands = new Collection();
commands.forEach(cmd => client.commands.set(cmd.data.name, cmd));

// ─── Register Slash Commands ──────────────────────────────────────────────────
async function registerCommandsForGuild(guildId) {
  if (!guildId) return;
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log(`🔄 Registering slash commands for guild ${guildId}...`);
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
      { body: commands.map(cmd => cmd.data.toJSON()) }
    );
    console.log(`✅ Slash commands registered for guild: ${guildId}`);
  } catch (err) {
    console.error(`❌ Failed to register commands for guild ${guildId}:`, err.message);
  }
}

// ─── Proactive Alerts ─────────────────────────────────────────────────────────
const lastAlertSent   = new Map();
const ALERT_COOLDOWN  = 2 * 60 * 60 * 1000; // 2 hours

async function checkAndSendAlerts() {
  try {
    // Check if alerts are paused
    const pausedUntil = await getSetting("alerts_paused_until").catch(() => null);
    if (pausedUntil && new Date(pausedUntil) > new Date()) return;

    const [spike, surge] = await Promise.all([detectSentimentSpike(), detectIssueSurge()]);

    if (spike) {
      const last = lastAlertSent.get("spike") || 0;
      if (Date.now() - last > ALERT_COOLDOWN) {
        lastAlertSent.set("spike", Date.now());
        const msg =
          `⚠️ *Sentiment Alert*\n\nNegative sentiment spike detected in the last hour\\!\n\n` +
          `📉 Last hour avg: *${spike.recent_avg.toFixed(3)}*\n` +
          `📊 24h baseline: *${spike.baseline_avg.toFixed(3)}*\n` +
          `📉 Drop: *${spike.delta.toFixed(3)}*\n` +
          `💬 Messages in last hour: *${spike.recent_count}*`;
        const reportChat = process.env.TELEGRAM_REPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
        if (reportChat) await sendTelegramMessage(reportChat, msg).catch(() => {});
        const channelId = process.env.REPORT_CHANNEL_ID;
        if (channelId) {
          const ch = await client.channels.fetch(channelId).catch(() => null);
          if (ch) await ch.send({ embeds: [
            new EmbedBuilder()
              .setTitle("⚠️ Sentiment Spike Alert")
              .setDescription(`Negative sentiment spike detected!\n\n📉 Last hour avg: **${spike.recent_avg.toFixed(3)}**\n📊 24h baseline: **${spike.baseline_avg.toFixed(3)}**\n📉 Drop: **${spike.delta.toFixed(3)}**\n💬 Messages: **${spike.recent_count}**`)
              .setColor(0xe74c3c).setTimestamp()
          ]}).catch(() => {});
        }
        console.log("🚨 Sent sentiment spike alert");
      }
    }

    if (surge) {
      const last = lastAlertSent.get("surge") || 0;
      if (Date.now() - last > ALERT_COOLDOWN) {
        lastAlertSent.set("surge", Date.now());
        const msg =
          `🚨 *Issue Surge Alert*\n\nUnusual spike in reported issues\\!\n\n` +
          `🐛 Issues in last 30 min: *${surge.recent_issues}*\n` +
          `📊 Hourly average: *${surge.hourly_avg.toFixed(1)}*`;
        const reportChat = process.env.TELEGRAM_REPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
        if (reportChat) await sendTelegramMessage(reportChat, msg).catch(() => {});
        const channelId = process.env.REPORT_CHANNEL_ID;
        if (channelId) {
          const ch = await client.channels.fetch(channelId).catch(() => null);
          if (ch) await ch.send({ embeds: [
            new EmbedBuilder()
              .setTitle("🚨 Issue Surge Alert")
              .setDescription(`Unusual spike in reported issues!\n\n🐛 Issues in last 30 min: **${surge.recent_issues}**\n📊 Hourly average: **${surge.hourly_avg.toFixed(1)}**`)
              .setColor(0xe67e22).setTimestamp()
          ]}).catch(() => {});
        }
        console.log("🚨 Sent issue surge alert");
      }
    }
  } catch (err) {
    console.error("❌ Alert check failed:", err.message);
  }
}

// ─── Schedule Reports ─────────────────────────────────────────────────────────
let dailyCronTask = null;

async function scheduleReports() {
  // Load saved cron time from DB (falls back to env var or default 9 AM)
  const savedCron = await getSetting("daily_cron").catch(() => null);
  const dailyCron = savedCron || process.env.REPORT_CRON || "0 9 * * *";

  if (cron.validate(dailyCron)) {
    dailyCronTask = cron.schedule(dailyCron, async () => {
      if (isReportPaused("daily")) {
        console.log(`⏸️  Daily report skipped (${reportState.dailySkipCount} remaining).`);
        consumeSkip("daily");
        return;
      }
      console.log("⏰ Running daily sentiment report...");
      await sendDailyReport(client);
      await sendTelegramDailyReport();
    });
    console.log(`📅 Daily report scheduled: "${dailyCron}"`);
  }

  const weeklyCron = process.env.WEEKLY_CRON || "0 9 * * 1";
  if (cron.validate(weeklyCron)) {
    cron.schedule(weeklyCron, async () => {
      if (isReportPaused("weekly")) {
        console.log(`⏸️  Weekly digest skipped (${reportState.weeklySkipCount} remaining).`);
        consumeSkip("weekly");
        return;
      }
      console.log("📋 Running weekly digest...");
      await sendWeeklyDigest(client);
      const tgParts    = await buildWeeklyDigestTelegram();
      const reportChat = process.env.TELEGRAM_REPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
      if (reportChat) {
        for (const part of tgParts) {
          await sendTelegramMessage(reportChat, part);
        }
      }
    });
    console.log(`📋 Weekly digest scheduled: "${weeklyCron}" (every Monday)`);
  }

  // Register the reschedule callback so telegram.js can call it via scheduler.js
  registerReschedule(async (newCron) => {
    if (!cron.validate(newCron)) return false;
    if (dailyCronTask) { dailyCronTask.stop(); dailyCronTask = null; }
    dailyCronTask = cron.schedule(newCron, async () => {
      if (isReportPaused("daily")) { consumeSkip("daily"); return; }
      console.log("⏰ Running daily sentiment report...");
      await sendDailyReport(client);
      await sendTelegramDailyReport();
    });
    await setSetting("daily_cron", newCron);
    console.log(`📅 Daily report rescheduled to: "${newCron}"`);
    return true;
  });

  // Proactive alert check every 15 minutes
  cron.schedule("*/15 * * * *", checkAndSendAlerts);
  console.log("🔔 Proactive alert checks scheduled (every 15 min)");
}

// ─── Startup — DB + Telegram run independently of Discord ────────────────────
async function startCore() {
  try {
    await initDB();
    await loadCustomKeywords();
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }
  startTelegramBot();
}

startCore();

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`\n🤖 Discord: Logged in as ${client.user.tag}`);
  console.log(`📊 Tracking sentiment in guild: ${process.env.GUILD_ID}`);
  console.log(`📬 Reports channel: ${process.env.REPORT_CHANNEL_ID}\n`);

  await registerCommandsForGuild(process.env.GUILD_ID);
  await registerCommandsForGuild(process.env.GUILD_ID_2);
  await scheduleReports();
});

// ─── 30-Second Delay Queue ────────────────────────────────────────────────────
const TRACK_DELAY_MS  = 30 * 1000;
const pendingMessages = new Map();

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (IGNORED_CHANNELS.includes(message.channel.id)) return;

  const text = message.content.trim();
  if (text.length < 5) return;

  const stripped = text
    .replace(/<@!?\d+>/g, "")
    .replace(/<:\w+:\d+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
  if (stripped.length < 5) return;

  if (isSpam(stripped)) {
    console.log(`🚫 Spam detected from ${message.author.username}, skipping`);
    return;
  }

  const { score, label } = analyzeSentiment(stripped);
  const category         = await classifyMessageAI(stripped);
  const community        = COMMUNITY_MAP[message.guild?.id] || "discord_main";

  const payload = {
    message_id:   message.id,
    user_id:      message.author.id,
    username:     message.author.username,
    channel_id:   message.channel.id,
    channel_name: message.channel.name || "unknown",
    score, label, category,
    message_text: stripped.slice(0, 1000),
    community,
    platform: "discord",
  };

  const timeout = setTimeout(async () => {
    pendingMessages.delete(message.id);
    try { await insertSentiment(payload); }
    catch (err) { console.error("❌ Failed to insert sentiment:", err.message); }
  }, TRACK_DELAY_MS);

  pendingMessages.set(message.id, timeout);
});

// ─── Handle Deleted Messages ──────────────────────────────────────────────────
client.on("messageDelete", async (message) => {
  if (pendingMessages.has(message.id)) {
    clearTimeout(pendingMessages.get(message.id));
    pendingMessages.delete(message.id);
    console.log(`🗑️  Cancelled pending message — deleted before tracking`);
    return;
  }
  try {
    const removed = await deleteByMessageId(message.id);
    if (removed) console.log(`🗑️  Removed ${removed.category} message from DB`);
  } catch (err) {
    console.error("❌ Failed to handle message delete:", err.message);
  }
});

client.on("messageDeleteBulk", async (messages) => {
  for (const message of messages.values()) {
    if (pendingMessages.has(message.id)) {
      clearTimeout(pendingMessages.get(message.id));
      pendingMessages.delete(message.id);
    } else {
      try { await deleteByMessageId(message.id); } catch (_) {}
    }
  }
  console.log(`🗑️  Bulk delete handled: ${messages.size} messages`);
});

// ─── Purge on Ban ─────────────────────────────────────────────────────────────
client.on("guildBanAdd", async (ban) => {
  try {
    const deleted = await deleteAllByUser(ban.user.username, ban.user.id);
    if (deleted > 0)
      console.log(`🚫 Banned @${ban.user.username} — purged ${deleted} record(s) from DB`);
  } catch (err) {
    console.error("❌ Failed to purge banned user:", err.message);
  }
});

// ─── Purge on Kick ────────────────────────────────────────────────────────────
client.on("guildMemberRemove", async (member) => {
  try {
    // Fetch audit log to distinguish kicks from voluntary leaves
    const logs = await member.guild.fetchAuditLogs({ type: 20, limit: 5 }).catch(() => null);
    if (!logs) return;
    const entry = logs.entries.find(e =>
      e.target?.id === member.id &&
      Date.now() - e.createdTimestamp < 5000
    );
    if (!entry) return; // voluntary leave — do nothing
    const deleted = await deleteAllByUser(member.user.username, member.user.id);
    if (deleted > 0)
      console.log(`👢 Kicked @${member.user.username} — purged ${deleted} record(s) from DB`);
  } catch (err) {
    console.error("❌ Failed to purge kicked user:", err.message);
  }
});

// ─── Slash Commands ───────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  console.log(`🎮 Interaction: type=${interaction.type} isChatInput=${interaction.isChatInputCommand()} name=${interaction.commandName||'n/a'}`);
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) {
    console.error(`❌ Unknown command: ${interaction.commandName}`);
    return interaction.reply({ content: "Unknown command.", ephemeral: true });
  }
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`❌ Error in /${interaction.commandName}:`, err.message);
    const reply = { content: "⚠️ An error occurred running that command." };
    if (interaction.deferred) await interaction.editReply(reply);
    else await interaction.reply(reply);
  }
});

// ─── Error Handling ───────────────────────────────────────────────────────────
client.on("error", err => console.error("❌ Client error:", err.message));
client.on("warn",  msg => console.warn("⚠️  Warning:", msg));
client.on("debug", msg => {
  if (msg.includes("Connecting") || msg.includes("connect") || msg.includes("identify") ||
      msg.includes("HELLO") || msg.includes("token") || msg.includes("gateway") ||
      msg.includes("WebSocket") || msg.includes("ws")) {
    console.log("🔍 Discord:", msg);
  }
});
process.on("uncaughtException",  err => console.error("❌ Uncaught Exception:", err));
process.on("unhandledRejection", err => console.error("❌ Unhandled Rejection:", err));

// ─── Dashboard + Keep-Alive Server ───────────────────────────────────────────
http.createServer(async (req, res) => {
  if (req.url === "/api/dashboard") {
    try {
      const data = await getDashboardData();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else {
    const htmlPath = path.join(__dirname, "dashboard.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(200); res.end("Bot is running!");
    }
  }
}).listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Keep-alive server on port ${process.env.PORT || 3000}`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function loginDiscord() {
  // Test if Discord's API is reachable before attempting login
  try {
    const https = require("https");
    await new Promise((resolve, reject) => {
      const req = https.get("https://discord.com/api/v10/gateway", { timeout: 10000 }, (res) => {
        console.log(`🔍 Discord API reachable — HTTP ${res.statusCode}`);
        resolve();
      });
      req.on("error",   err => reject(new Error(`Discord API unreachable: ${err.message}`)));
      req.on("timeout", ()  => { req.destroy(); reject(new Error("Discord API request timed out")); });
    });
  } catch (err) {
    console.error(`❌ Pre-login check failed: ${err.message}`);
    console.error("❌ Render cannot reach discord.com — Discord bot will be offline");
    return;
  }

  console.log("🔑 Attempting Discord login...");
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Login timed out after 60s")), 60000)
  );
  try {
    await Promise.race([client.login(process.env.DISCORD_TOKEN), timeout]);
    console.log("🔑 Login successful");
  } catch (err) {
    console.error("❌ Login failed:", err.message);
  }
}

loginDiscord();