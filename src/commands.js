const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require("discord.js");
const {
  getSummary, getTrend, getChannelBreakdown, getRecentIssues, getRecentFeedback,
  getCustomKeywords, addCustomKeyword, removeCustomKeyword, deleteByMessageId, cleanOldRecords,
} = require("./database");
const { buildDailyReport, buildWeeklyDigest } = require("./reporter");
const { getAllKeywords, loadCustomKeywords }   = require("./classifier");

const commands = [

  // ── /sentiment ──────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("sentiment").setDescription("View combined sentiment summary across all communities")
      .addIntegerOption(opt => opt.setName("days").setDescription("Days to look back (default: 7)").setMinValue(1).setMaxValue(30).setRequired(false)),
    async execute(interaction) {
      await interaction.deferReply();
      const days = interaction.options.getInteger("days") || 7;
      const [summary, trend] = await Promise.all([getSummary(days), getTrend(days)]);
      if (!summary.length) return interaction.editReply("📭 No sentiment data yet.");

      let totalMsgs = 0, weightedScore = 0, summaryText = "";
      summary.forEach(({ label, count, avg_score }) => {
        const emoji = label === "positive" ? "🟢" : label === "negative" ? "🔴" : "🟡";
        summaryText += `${emoji} **${label}**: ${count} msgs\n`;
        totalMsgs += count; weightedScore += avg_score * count;
      });
      const overall     = totalMsgs > 0 ? weightedScore / totalMsgs : 0;
      const overallWord = overall > 0.3 ? "🔥 Very happy" : overall > 0.1 ? "😄 Happy" : overall > 0.02 ? "🙂 Mostly positive" : overall > -0.02 ? "😐 Mixed / neutral" : overall > -0.1 ? "😕 A bit negative" : overall > -0.3 ? "😠 Unhappy" : "🚨 Very unhappy";
      return interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setTitle(`📊 Sentiment — Last ${days} Day${days > 1 ? "s" : ""}`)
          .setColor(overall > 0.05 ? 0x2ecc71 : overall < -0.05 ? 0xe74c3c : 0xf39c12)
          .setDescription(`**${totalMsgs}** messages · Overall mood: ${overallWord}`)
          .addFields({ name: "Breakdown", value: summaryText || "No data", inline: false }, { name: "Trend", value: trendText, inline: false })
          .setTimestamp()
      ]});
    },
  },

  // ── /channels ───────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("channels").setDescription("View sentiment breakdown by channel across all communities")
      .addIntegerOption(opt => opt.setName("days").setDescription("Days to look back (default: 1)").setMinValue(1).setMaxValue(30).setRequired(false)),
    async execute(interaction) {
      await interaction.deferReply();
      const days      = interaction.options.getInteger("days") || 1;
      const breakdown = await getChannelBreakdown(days);
      if (!breakdown.length) return interaction.editReply("📭 No channel data yet.");
      const text = breakdown.map(({ community, channel_name, platform, avg_score, message_count }) => {
        const mood = avg_score > 0.05 ? "🟢" : avg_score < -0.05 ? "🔴" : "🟡";
        const plat = platform === "telegram" ? "📱" : "💬";
        return `${mood}${plat} **${community}/#${channel_name}** — \`${avg_score.toFixed(3)}\` · ${message_count} msgs`;
      }).join("\n");
      return interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle(`📡 Channel Sentiment — Last ${days} Day${days > 1 ? "s" : ""}`).setColor(0x5865f2).setDescription(text).setTimestamp()
      ]});
    },
  },

  // ── /issues ─────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("issues").setDescription("View recent issues reported across all communities")
      .addIntegerOption(opt => opt.setName("days").setDescription("Days to look back (default: 1)").setMinValue(1).setMaxValue(30).setRequired(false)),
    async execute(interaction) {
      await interaction.deferReply();
      const days   = interaction.options.getInteger("days") || 1;
      const issues = await getRecentIssues(days, 10);
      if (!issues.length) return interaction.editReply(`✅ No issues in the last ${days} day${days > 1 ? "s" : ""}!`);
      const text = issues.map(({ username, community, platform, message_id, message_text }) => {
        const plat    = platform === "telegram" ? "📱" : "💬";
        const idLine  = platform === "telegram"
          ? `\n> 🆔 \`/tgdelete ${message_id}\``
          : `\n> 🆔 \`/delete ${message_id}\``;
        return `🔴${plat} **${username}** [${community}]\n> ${message_text?.slice(0, 200)}${message_text?.length > 200 ? "..." : ""}${idLine}`;
      }).join("\n\n");
      return interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle(`🐛 Issues — Last ${days} Day${days > 1 ? "s" : ""} (${issues.length} found)`).setColor(0xe74c3c).setDescription(text).setTimestamp()
      ]});
    },
  },

  // ── /feedback ────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("feedback").setDescription("View recent feedback across all communities")
      .addIntegerOption(opt => opt.setName("days").setDescription("Days to look back (default: 1)").setMinValue(1).setMaxValue(30).setRequired(false)),
    async execute(interaction) {
      await interaction.deferReply();
      const days     = interaction.options.getInteger("days") || 1;
      const feedback = await getRecentFeedback(days, 10);
      if (!feedback.length) return interaction.editReply(`📭 No feedback in the last ${days} day${days > 1 ? "s" : ""}.`);
      const text = feedback.map(({ username, community, platform, message_id, message_text }) => {
        const plat   = platform === "telegram" ? "📱" : "💬";
        const idLine = platform === "telegram"
          ? `\n> 🆔 \`/tgdelete ${message_id}\``
          : `\n> 🆔 \`/delete ${message_id}\``;
        return `💬${plat} **${username}** [${community}]\n> ${message_text?.slice(0, 200)}${message_text?.length > 200 ? "..." : ""}${idLine}`;
      }).join("\n\n");
      return interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle(`💡 Feedback — Last ${days} Day${days > 1 ? "s" : ""} (${feedback.length} found)`).setColor(0x3498db).setDescription(text).setTimestamp()
      ]});
    },
  },

  // ── /report ──────────────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder().setName("report").setDescription("Manually trigger today's full sentiment report"),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const embed = await buildDailyReport();
      await interaction.channel.send({ embeds: [embed] });
      return interaction.editReply("✅ Report sent!");
    },
  },

  // ── /weeklyreport ─────────────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder().setName("weeklyreport").setDescription("Manually trigger the weekly digest"),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const embed = await buildWeeklyDigest();
      await interaction.channel.send({ embeds: [embed] });
      return interaction.editReply("✅ Weekly digest sent!");
    },
  },

  // ── /delete (admin only) ──────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("delete").setDescription("Remove a false positive from the database (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addStringOption(opt => opt.setName("message_id").setDescription("The Discord message ID to remove").setRequired(true)),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const messageId = interaction.options.getString("message_id");
      const removed   = await deleteByMessageId(messageId);
      if (!removed) return interaction.editReply(`⚠️ No record found for message ID \`${messageId}\`. It may not have been tracked or was already removed.`);
      return interaction.editReply(
        `✅ Removed from database:\n> ID: \`${messageId}\`\n> Category: **${removed.category}**\n> Tracked at: \`${new Date(removed.timestamp).toLocaleString()}\``
      );
    },
  },

  // ── /cleandb (admin only) ─────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("cleandb").setDescription("Remove unverifiable issue/feedback records with no message ID (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { before, deleted } = await cleanOldRecords();
      const beforeText = before.map(({ category, total, no_id }) =>
        `**${category}**: ${total} total, ${no_id} with no ID`
      ).join("\n") || "No issue/feedback records found.";
      return interaction.editReply(
        `🧹 **Database Cleanup Complete**\n\n**Before:**\n${beforeText}\n\n🗑️ Deleted **${deleted}** unverifiable records.`
      );
    },
  },

  // ── /keywords (admin only) ────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("keywords").setDescription("Manage custom issue/feedback keywords (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addSubcommand(sub => sub.setName("list").setDescription("List all custom keywords"))
      .addSubcommand(sub =>
        sub.setName("add").setDescription("Add a custom keyword")
          .addStringOption(opt => opt.setName("keyword").setDescription("Keyword to add").setRequired(true))
          .addStringOption(opt => opt.setName("category").setDescription("issue or feedback").setRequired(true)
            .addChoices({ name: "Issue", value: "issue" }, { name: "Feedback", value: "feedback" }))
      )
      .addSubcommand(sub =>
        sub.setName("remove").setDescription("Remove a custom keyword")
          .addStringOption(opt => opt.setName("keyword").setDescription("Keyword to remove").setRequired(true))
      ),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const sub = interaction.options.getSubcommand();

      if (sub === "list") {
        const { issue, feedback } = getAllKeywords();
        return interaction.editReply({ embeds: [
          new EmbedBuilder().setTitle("📝 Keyword Configuration").setColor(0x5865f2)
            .addFields(
              { name: `🐛 Issue Keywords (${issue.base.length} base + ${issue.custom.length} custom)`,
                value: issue.custom.length > 0 ? `**Custom:** ${issue.custom.map(k => `\`${k}\``).join(", ")}\n**Base:** ${issue.base.length} built-in` : `No custom keywords yet. **Base:** ${issue.base.length} built-in`, inline: false },
              { name: `💡 Feedback Keywords (${feedback.base.length} base + ${feedback.custom.length} custom)`,
                value: feedback.custom.length > 0 ? `**Custom:** ${feedback.custom.map(k => `\`${k}\``).join(", ")}\n**Base:** ${feedback.base.length} built-in` : `No custom keywords yet. **Base:** ${feedback.base.length} built-in`, inline: false }
            )
        ]});
      } else if (sub === "add") {
        const keyword  = interaction.options.getString("keyword").toLowerCase().trim();
        const category = interaction.options.getString("category");
        await addCustomKeyword(keyword, category, interaction.user.username);
        await loadCustomKeywords();
        return interaction.editReply(`✅ Added \`${keyword}\` as a **${category}** keyword. Active immediately.`);
      } else if (sub === "remove") {
        const keyword = interaction.options.getString("keyword").toLowerCase().trim();
        const removed = await removeCustomKeyword(keyword);
        if (!removed) return interaction.editReply(`⚠️ Keyword \`${keyword}\` not found.`);
        await loadCustomKeywords();
        return interaction.editReply(`✅ Removed \`${keyword}\` from custom keywords.`);
      }
    },
  },

  // ── /deleteuser (admin only) ──────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("deleteuser")
      .setDescription("Delete all issue/feedback records from a specific user (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addStringOption(opt =>
        opt.setName("username").setDescription("Username to remove e.g. abhinayxsingh (use this OR mention)").setRequired(false)
      )
      .addUserOption(opt =>
        opt.setName("user").setDescription("Mention the user directly e.g. @john_doe (use this OR username)").setRequired(false)
      )
      .addIntegerOption(opt =>
        opt.setName("days").setDescription("How many days back to delete (default: 7)").setMinValue(1).setMaxValue(30).setRequired(false)
      ),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const mentionedUser = interaction.options.getUser("user");
      const usernameInput = interaction.options.getString("username")?.replace("@", "").trim();
      const days          = interaction.options.getInteger("days") || 7;

      if (!mentionedUser && !usernameInput) {
        return interaction.editReply(
          `⚠️ Please provide either:\n` +
          `• A **username** e.g. \`/deleteuser username:abhinayxsingh\`\n` +
          `• A **user mention** e.g. \`/deleteuser user:@john_doe\``
        );
      }

      const { deleteByUsername, deleteByUserId } = require("./database");
      let removed;
      let displayName;

      if (mentionedUser) {
        // Delete by Discord user ID — most accurate
        removed     = await deleteByUserId(mentionedUser.id, days);
        displayName = `${mentionedUser.username} (ID: ${mentionedUser.id})`;
      } else {
        // Delete by username — works for TG users too
        removed     = await deleteByUsername(usernameInput, days);
        displayName = usernameInput;
      }

      if (!removed.length) {
        return interaction.editReply(
          `⚠️ No issue/feedback records found for **${displayName}** in the last ${days} day${days > 1 ? "s" : ""}.\n` +
          `Try increasing the days range e.g. \`days: 30\`.`
        );
      }

      return interaction.editReply(
        `✅ Deleted **${removed.length}** record${removed.length > 1 ? "s" : ""} from **${displayName}**:\n` +
        removed.map(r => `🗑️ ${r.category}: ${r.message_text?.slice(0, 60)}...`).join("\n")
      );
    },
  },

  // ── /pausereport (admin only) ─────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("pausereport")
      .setDescription("Pause automatic reports (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addStringOption(opt =>
        opt.setName("type").setDescription("Which report to pause").setRequired(true)
          .addChoices(
            { name: "Daily report", value: "daily" },
            { name: "Weekly digest", value: "weekly" },
            { name: "Both", value: "both" }
          )
      )
      .addIntegerOption(opt =>
        opt.setName("times").setDescription("Skip next N reports e.g. 1 = skip tomorrow only. Leave empty to pause indefinitely").setMinValue(1).setMaxValue(30).setRequired(false)
      ),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const type  = interaction.options.getString("type");
      const times = interaction.options.getInteger("times") || null;
      const { reportState } = require("./bot");

      if (type === "daily" || type === "both") {
        reportState.dailyPaused     = true;
        reportState.dailySkipCount  = times || 0;
        reportState.dailyPausedUntil = null;
      }
      if (type === "weekly" || type === "both") {
        reportState.weeklyPaused      = true;
        reportState.weeklySkipCount   = times || 0;
        reportState.weeklyPausedUntil = null;
      }

      const typeLabel  = type === "both" ? "Daily + Weekly reports" : type === "daily" ? "Daily report" : "Weekly digest";
      const timesLabel = times
        ? `for the next **${times}** report${times > 1 ? "s" : ""} — will auto-resume after`
        : "indefinitely — use `/resumereport` to turn back on";

      return interaction.editReply(
        `⏸️ **${typeLabel}** paused ${timesLabel}.\n\n` +
        `Both Discord and Telegram reports are affected.\n` +
        `Check status anytime with \`/reportstatus\`.`
      );
    },
  },

  // ── /resumereport (admin only) ────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("resumereport")
      .setDescription("Resume automatic reports (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addStringOption(opt =>
        opt.setName("type").setDescription("Which report to resume").setRequired(true)
          .addChoices(
            { name: "Daily report", value: "daily" },
            { name: "Weekly digest", value: "weekly" },
            { name: "Both", value: "both" }
          )
      ),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const type = interaction.options.getString("type");
      const { reportState } = require("./bot");

      if (type === "daily" || type === "both") {
        reportState.dailyPaused      = false;
        reportState.dailyPausedUntil = null;
      }
      if (type === "weekly" || type === "both") {
        reportState.weeklyPaused      = false;
        reportState.weeklyPausedUntil = null;
      }

      const typeLabel = type === "both" ? "Daily + Weekly reports" : type === "daily" ? "Daily report" : "Weekly digest";
      return interaction.editReply(`▶️ **${typeLabel}** resumed. Reports will send at their next scheduled time.`);
    },
  },

  // ── /reportstatus (admin only) ────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("reportstatus")
      .setDescription("Check if reports are paused or running (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const { reportState } = require("./bot");

      const dailyStatus  = reportState.dailyPaused
        ? `⏸️ Paused${reportState.dailySkipCount > 0 ? ` — ${reportState.dailySkipCount} report${reportState.dailySkipCount !== 1 ? "s" : ""} left to skip` : " indefinitely"}`
        : "▶️ Running";
      const weeklyStatus = reportState.weeklyPaused
        ? `⏸️ Paused${reportState.weeklySkipCount > 0 ? ` — ${reportState.weeklySkipCount} report${reportState.weeklySkipCount !== 1 ? "s" : ""} left to skip` : " indefinitely"}`
        : "▶️ Running";

      return interaction.editReply(
        `📊 **Report Status**\n\n` +
        `📅 Daily report: ${dailyStatus}\n` +
        `📋 Weekly digest: ${weeklyStatus}\n\n` +
        `_Both Discord and Telegram reports share the same status._`
      );
    },
  },

  // ── /deleteuserid (admin only) ────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("deleteuserid")
      .setDescription("Delete all issue/feedback records by Discord user ID (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addStringOption(opt =>
        opt.setName("user_id").setDescription("The Discord user ID e.g. 123456789012345678").setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName("days").setDescription("How many days back to delete (default: 7)").setMinValue(1).setMaxValue(30).setRequired(false)
      ),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const userId = interaction.options.getString("user_id").trim();
      const days   = interaction.options.getInteger("days") || 7;

      const { deleteByUserId } = require("./database");
      const removed = await deleteByUserId(userId, days);

      if (!removed.length) {
        return interaction.editReply(
          `⚠️ No issue/feedback records found for user ID \`${userId}\` in the last ${days} day${days > 1 ? "s" : ""}.\n` +
          `Try increasing the days range e.g. \`days: 30\`.`
        );
      }

      const username = removed[0]?.username || userId;
      return interaction.editReply(
        `✅ Deleted **${removed.length}** record${removed.length > 1 ? "s" : ""} from **${username}** (ID: \`${userId}\`):\n` +
        removed.map(r => `🗑️ ${r.category}: ${r.message_text?.slice(0, 60)}...`).join("\n")
      );
    },
  },

  // ── /track (admin only) ───────────────────────────────────────────────────
  {
    data: new SlashCommandBuilder()
      .setName("track")
      .setDescription("Manually add a message as an issue or feedback (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addStringOption(opt =>
        opt.setName("category").setDescription("issue or feedback").setRequired(true)
          .addChoices({ name: "🐛 Issue", value: "issue" }, { name: "💡 Feedback", value: "feedback" })
      )
      .addStringOption(opt =>
        opt.setName("text").setDescription("The message content to track").setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("username").setDescription("Username of who sent it (e.g. john_doe)").setRequired(true)
      ),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const category = interaction.options.getString("category");
      const text     = interaction.options.getString("text");
      const username = interaction.options.getString("username").replace("@", "").trim();

      const { analyzeSentiment } = require("./sentiment");
      const { insertSentiment }  = require("./database");
      const { score, label }     = analyzeSentiment(text);
      const community            = process.env.COMMUNITY_NAME || "discord_main";

      await insertSentiment({
        message_id:   `manual_${Date.now()}`,
        user_id:      `manual_${username}`,
        username,
        channel_id:   interaction.channel.id,
        channel_name: interaction.channel.name || "unknown",
        score, label, category,
        message_text: text.slice(0, 1000),
        community,
        platform: "discord",
      });

      const catEmoji = category === "issue" ? "🐛" : "💡";
      return interaction.editReply(
        `✅ Manually tracked as **${category}**:\n` +
        `${catEmoji} **${username}**: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`
      );
    },
  },

];

module.exports = commands;