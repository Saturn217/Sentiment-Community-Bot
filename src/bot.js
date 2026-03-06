// Only load .env file in local development
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Collection,
} = require("discord.js");
const http                        = require("http");
const cron                        = require("node-cron");
const { analyzeSentiment }        = require("./sentiment");
const { classifyMessage }         = require("./classifier");
const { initDB, insertSentiment } = require("./database");
const { sendDailyReport }         = require("./reporter");
const { startTelegramBot, sendTelegramDailyReport } = require("./telegram");
const commands                    = require("./commands");

// ─── Debug ────────────────────────────────────────────────────────────────────
console.log("ENV CHECK:", {
  hasToken:    !!process.env.DISCORD_TOKEN,
  hasClientId: !!process.env.CLIENT_ID,
  hasGuildId:  !!process.env.GUILD_ID,
  hasChannel:  !!process.env.REPORT_CHANNEL_ID,
  hasDatabase: !!process.env.DATABASE_URL,
  hasTelegram: !!process.env.TELEGRAM_TOKEN,
  hasTgChatId: !!process.env.TELEGRAM_CHAT_ID,
  tgChatId:    process.env.TELEGRAM_CHAT_ID, // log actual value
  nodeEnv:     process.env.NODE_ENV,
});

// ─── Parse optional ignored channels ─────────────────────────────────────────
const IGNORED_CHANNELS = process.env.IGNORED_CHANNELS
  ? process.env.IGNORED_CHANNELS.split(",").map((id) => id.trim())
  : [];

// ─── Client Setup ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();
commands.forEach((cmd) => client.commands.set(cmd.data.name, cmd));

// ─── Register Slash Commands ──────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log("🔄 Registering slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands.map((cmd) => cmd.data.toJSON()) }
    );
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("❌ Failed to register commands:", err.message);
  }
}

// ─── Schedule Daily Reports (Discord + Telegram) ──────────────────────────────
function scheduleDailyReport() {
  const cronExpression = process.env.REPORT_CRON || "0 9 * * *";

  if (!cron.validate(cronExpression)) {
    console.error(`❌ Invalid REPORT_CRON expression: "${cronExpression}"`);
    return;
  }

  cron.schedule(cronExpression, async () => {
    console.log("⏰ Running scheduled daily sentiment report...");
    // Send to Discord
    await sendDailyReport(client);
    // Send to Telegram
    await sendTelegramDailyReport();
  });

  console.log(`📅 Daily report scheduled: "${cronExpression}"`);
}

// ─── Discord Events ───────────────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`\n🤖 Discord: Logged in as ${client.user.tag}`);
  console.log(`📊 Tracking sentiment in guild: ${process.env.GUILD_ID}`);
  console.log(`📬 Reports channel: ${process.env.REPORT_CHANNEL_ID}\n`);

  try {
    await initDB();
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }

  try {
    await registerCommands();
  } catch (err) {
    console.error("❌ Command registration failed:", err.message);
  }

  scheduleDailyReport();

  // Start Telegram bot
  startTelegramBot();
});

// ── Track message sentiment ───────────────────────────────────────────────────
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

  const { score, label } = analyzeSentiment(stripped);
  const category         = classifyMessage(stripped);

  try {
    await insertSentiment({
      user_id:      message.author.id,
      username:     message.author.username,
      channel_id:   message.channel.id,
      channel_name: message.channel.name || "unknown",
      score,
      label,
      category,
      message_text: stripped.slice(0, 300), // store up to 300 chars
    });
  } catch (err) {
    console.error("❌ Failed to insert sentiment:", err.message);
  }
});

// ── Handle slash commands ─────────────────────────────────────────────────────
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
client.on("error", (err) => console.error("❌ Client error:", err.message));
client.on("warn",  (msg) => console.warn("⚠️  Client warning:", msg));

process.on("uncaughtException",   (err) => console.error("❌ Uncaught Exception:", err));
process.on("unhandledRejection",  (err) => console.error("❌ Unhandled Rejection:", err));

// ─── Keep-Alive HTTP Server ───────────────────────────────────────────────────
http.createServer((req, res) => res.end("Bot is running!")).listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Keep-alive server on port ${process.env.PORT || 3000}`);
});

// ─── Start Discord Bot ────────────────────────────────────────────────────────
console.log("🔑 Attempting Discord login...");
client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log("🔑 Login successful"))
  .catch((err) => console.error("❌ Login failed:", err.message));