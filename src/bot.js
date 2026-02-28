require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Collection,
} = require("discord.js");
const cron                 = require("node-cron");
const { analyzeSentiment } = require("./sentiment");
const { insertSentiment }  = require("./database");
const { sendDailyReport }  = require("./reporter");
const commands             = require("./commands");

// ─── Validation ───────────────────────────────────────────────────────────────
const REQUIRED_ENV = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "REPORT_CHANNEL_ID"];
REQUIRED_ENV.forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
});

// Parse optional ignored channels
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

// Load slash commands into collection
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

// ─── Schedule Daily Report ────────────────────────────────────────────────────
function scheduleDailyReport() {
  const cronExpression = process.env.REPORT_CRON || "0 9 * * *";

  if (!cron.validate(cronExpression)) {
    console.error(`❌ Invalid REPORT_CRON expression: "${cronExpression}"`);
    console.error('   Use a valid cron format, e.g. "0 9 * * *" for 9:00 AM daily.');
    process.exit(1);
  }

  cron.schedule(cronExpression, async () => {
    console.log("⏰ Running scheduled daily sentiment report...");
    await sendDailyReport(client);
  });

  console.log(`📅 Daily report scheduled: "${cronExpression}"`);
}

// ─── Events ───────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`\n🤖 Logged in as ${client.user.tag}`);
  console.log(`📊 Tracking sentiment in guild: ${process.env.GUILD_ID}`);
  console.log(`📬 Reports channel: ${process.env.REPORT_CHANNEL_ID}\n`);

  await registerCommands();
  scheduleDailyReport();
});

// ── Track message sentiment ───────────────────────────────────────────────────
client.on("messageCreate", (message) => {
  // Skip bots
  if (message.author.bot) return;

  // Skip ignored channels
  if (IGNORED_CHANNELS.includes(message.channel.id)) return;

  // Skip very short messages (too little signal)
  const text = message.content.trim();
  if (text.length < 5) return;

  // Skip messages that are only mentions, emojis, or URLs
  const stripped = text
    .replace(/<@!?\d+>/g, "")    // mentions
    .replace(/<:\w+:\d+>/g, "")  // custom emojis
    .replace(/https?:\/\/\S+/g, "") // URLs
    .trim();
  if (stripped.length < 5) return;

  const { score, label } = analyzeSentiment(stripped);

  insertSentiment({
    user_id:      message.author.id,
    username:     message.author.username,
    channel_id:   message.channel.id,
    channel_name: message.channel.name || "unknown",
    score,
    label,
  });
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
    const reply = { content: "⚠️ An error occurred running that command.", ephemeral: true };
    if (interaction.deferred) await interaction.editReply(reply);
    else await interaction.reply(reply);
  }
});

// ─── Error Handling ───────────────────────────────────────────────────────────
client.on("error",   (err) => console.error("❌ Client error:",   err.message));
client.on("warn",    (msg) => console.warn ("⚠️  Client warning:", msg));

process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled rejection:", err);
});

// ─── Start ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);