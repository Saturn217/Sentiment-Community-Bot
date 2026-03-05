const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { getSummary, getTrend, getChannelBreakdown, getRecentIssues, getRecentFeedback } = require("./database");
const { buildDailyReport } = require("./reporter");

const commands = [
  // ── /sentiment ────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("sentiment")
      .setDescription("View community sentiment summary")
      .addIntegerOption((opt) =>
        opt.setName("days").setDescription("Days to look back (default: 7)").setMinValue(1).setMaxValue(30).setRequired(false)
      ),
    async execute(interaction) {
      await interaction.deferReply();
      const days    = interaction.options.getInteger("days") || 7;
      const summary = await getSummary(days);
      const trend   = await getTrend(days);

      if (!summary.length) return interaction.editReply("📭 No sentiment data yet. Send some messages first!");

      let totalMsgs = 0, weightedScore = 0, summaryText = "";
      summary.forEach(({ label, count, avg_score }) => {
        const emoji = label === "positive" ? "🟢" : label === "negative" ? "🔴" : "🟡";
        summaryText += `${emoji} **${label}**: ${count} msgs (avg: \`${avg_score.toFixed(3)}\`)\n`;
        totalMsgs     += count;
        weightedScore += avg_score * count;
      });

      let trendText = "";
      trend.forEach(({ date, avg_score, message_count }) => {
        const arrow = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
        trendText += `${arrow} \`${date}\` — \`${avg_score.toFixed(3)}\` (${message_count} msgs)\n`;
      });

      const overall = totalMsgs > 0 ? weightedScore / totalMsgs : 0;
      const embed = new EmbedBuilder()
        .setTitle(`📊 Sentiment Summary — Last ${days} Day${days > 1 ? "s" : ""}`)
        .setColor(overall > 0.05 ? 0x2ecc71 : overall < -0.05 ? 0xe74c3c : 0xf39c12)
        .setDescription(`**${totalMsgs}** messages analyzed`)
        .addFields(
          { name: "Breakdown", value: summaryText || "No data",             inline: false },
          { name: "Trend",     value: trendText   || "Not enough data yet.", inline: false }
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    },
  },

  // ── /channels ─────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("channels")
      .setDescription("View sentiment breakdown by channel")
      .addIntegerOption((opt) =>
        opt.setName("days").setDescription("Days to look back (default: 1)").setMinValue(1).setMaxValue(30).setRequired(false)
      ),
    async execute(interaction) {
      await interaction.deferReply();
      const days      = interaction.options.getInteger("days") || 1;
      const breakdown = await getChannelBreakdown(days);

      if (!breakdown.length) return interaction.editReply("📭 No channel data yet.");

      const text = breakdown.map(({ channel_name, avg_score, message_count }) => {
        const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        return `${mood} **#${channel_name}** — \`${avg_score.toFixed(3)}\` · ${message_count} msgs`;
      }).join("\n");

      const embed = new EmbedBuilder()
        .setTitle(`📡 Channel Sentiment — Last ${days} Day${days > 1 ? "s" : ""}`)
        .setColor(0x5865f2)
        .setDescription(text)
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    },
  },

  // ── /issues ───────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("issues")
      .setDescription("View recent issues reported by the community")
      .addIntegerOption((opt) =>
        opt.setName("days").setDescription("Days to look back (default: 1)").setMinValue(1).setMaxValue(30).setRequired(false)
      ),
    async execute(interaction) {
      await interaction.deferReply();
      const days   = interaction.options.getInteger("days") || 1;
      const issues = await getRecentIssues(days, 10);

      if (!issues.length) {
        return interaction.editReply(`✅ No issues reported in the last ${days} day${days > 1 ? "s" : ""}!`);
      }

      const text = issues.map(({ username, channel_name, message_text }) =>
        `🔴 **${username}** in #${channel_name}\n> ${message_text?.slice(0, 100)}${message_text?.length > 100 ? "..." : ""}`
      ).join("\n\n");

      const embed = new EmbedBuilder()
        .setTitle(`🐛 Issues — Last ${days} Day${days > 1 ? "s" : ""} (${issues.length} found)`)
        .setColor(0xe74c3c)
        .setDescription(text)
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    },
  },

  // ── /feedback ─────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("feedback")
      .setDescription("View recent feedback from the community")
      .addIntegerOption((opt) =>
        opt.setName("days").setDescription("Days to look back (default: 1)").setMinValue(1).setMaxValue(30).setRequired(false)
      ),
    async execute(interaction) {
      await interaction.deferReply();
      const days     = interaction.options.getInteger("days") || 1;
      const feedback = await getRecentFeedback(days, 10);

      if (!feedback.length) {
        return interaction.editReply(`📭 No feedback submitted in the last ${days} day${days > 1 ? "s" : ""}.`);
      }

      const text = feedback.map(({ username, channel_name, message_text }) =>
        `💬 **${username}** in #${channel_name}\n> ${message_text?.slice(0, 100)}${message_text?.length > 100 ? "..." : ""}`
      ).join("\n\n");

      const embed = new EmbedBuilder()
        .setTitle(`💡 Feedback — Last ${days} Day${days > 1 ? "s" : ""} (${feedback.length} found)`)
        .setColor(0x3498db)
        .setDescription(text)
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    },
  },

  // ── /report ───────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("report")
      .setDescription("Manually trigger today's full sentiment report"),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const embed = await buildDailyReport();
      await interaction.channel.send({ embeds: [embed] });
      return interaction.editReply("✅ Report sent!");
    },
  },
];

module.exports = commands;