const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getSummary, getTrend, getChannelBreakdown } = require("./database");
const { buildDailyReport } = require("./reporter");

const commands = [
  // ── /sentiment ────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("sentiment")
      .setDescription("View community sentiment summary")
      .addIntegerOption((opt) =>
        opt
          .setName("days")
          .setDescription("How many days to look back (default: 7)")
          .setMinValue(1)
          .setMaxValue(30)
          .setRequired(false)
      ),

    async execute(interaction) {
      await interaction.deferReply();
      const days    = interaction.options.getInteger("days") || 7;
      const summary = getSummary(days);
      const trend   = getTrend(days);

      if (!summary.length) {
        return interaction.editReply("📭 No sentiment data found for that period yet.");
      }

      let totalMsgs = 0;
      let weightedScore = 0;
      let summaryText = "";

      summary.forEach(({ label, count, avg_score }) => {
        const emoji = label === "positive" ? "🟢" : label === "negative" ? "🔴" : "🟡";
        summaryText += `${emoji} **${label}**: ${count} messages (avg: \`${avg_score.toFixed(3)}\`)\n`;
        totalMsgs     += count;
        weightedScore += avg_score * count;
      });

      const overall = totalMsgs > 0 ? weightedScore / totalMsgs : 0;

      let trendText = "";
      trend.forEach(({ date, avg_score, message_count }) => {
        const arrow = avg_score > 0.05 ? "📈" : avg_score < -0.05 ? "📉" : "➡️";
        trendText += `${arrow} \`${date}\` — \`${avg_score.toFixed(3)}\` (${message_count} msgs)\n`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`📊 Sentiment Summary — Last ${days} Day${days > 1 ? "s" : ""}`)
        .setColor(overall > 0.05 ? 0x2ecc71 : overall < -0.05 ? 0xe74c3c : 0xf39c12)
        .addFields(
          { name: "Breakdown", value: summaryText,            inline: false },
          { name: "Trend",     value: trendText || "No data", inline: false }
        )
        .setFooter({ text: `Total messages analyzed: ${totalMsgs}` })
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
        opt
          .setName("days")
          .setDescription("How many days to look back (default: 1)")
          .setMinValue(1)
          .setMaxValue(30)
          .setRequired(false)
      ),

    async execute(interaction) {
      await interaction.deferReply();
      const days      = interaction.options.getInteger("days") || 1;
      const breakdown = getChannelBreakdown(days);

      if (!breakdown.length) {
        return interaction.editReply("📭 No channel data available yet.");
      }

      let text = "";
      breakdown.forEach(({ channel_name, avg_score, message_count }) => {
        const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        text += `${mood} **#${channel_name}** — score: \`${avg_score.toFixed(3)}\` · ${message_count} msgs\n`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`📡 Channel Sentiment — Last ${days} Day${days > 1 ? "s" : ""}`)
        .setColor(0x5865f2)
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
      await interaction.deferReply({ ephemeral: true });
      const embed = buildDailyReport();
      await interaction.channel.send({ embeds: [embed] });
      return interaction.editReply("✅ Report sent!");
    },
  },
];

module.exports = commands;