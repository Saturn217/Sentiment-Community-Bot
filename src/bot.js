if (process.env.NODE_ENV !== "production") require("dotenv").config();

const { Client, GatewayIntentBits, REST, Routes, Collection } = require("discord.js");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const cron  = require("node-cron");

const { analyzeSentiment }                                             = require("./sentiment");
const { classifyMessage, loadCustomKeywords, isSpam }                  = require("./classifier");
const { initDB, insertSentiment, deleteByMessageId, getDashboardData } = require("./database");
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

// ─── Schedule Reports ─────────────────────────────────────────────────────────
function scheduleReports() {
  const dailyCron = process.env.REPORT_CRON || "0 9 * * *";
  if (cron.validate(dailyCron)) {
    cron.schedule(dailyCron, async () => {
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
}

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`\n🤖 Discord: Logged in as ${client.user.tag}`);
  console.log(`📊 Tracking sentiment in guild: ${process.env.GUILD_ID}`);
  console.log(`📬 Reports channel: ${process.env.REPORT_CHANNEL_ID}\n`);

  try {
    await initDB();
    await loadCustomKeywords();
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }

  await registerCommandsForGuild(process.env.GUILD_ID);
  await registerCommandsForGuild(process.env.GUILD_ID_2);
  scheduleReports();
  startTelegramBot();
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
  const category         = classifyMessage(stripped);
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

// ─── Slash Commands ───────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
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
console.log("🔑 Attempting Discord login...");
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log("🔑 Login successful"))
  .catch(err => console.error("❌ Login failed:", err.message));