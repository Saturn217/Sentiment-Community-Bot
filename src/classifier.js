const ISSUE_KEYWORDS = [
  "bug", "error", "broken", "not working", "doesnt work", "doesn't work",
  "cant login", "can't login", "unable to", "failed", "crash", "crashes",
  "crashing", "issue", "problem", "glitch", "freeze", "freezing", "stuck",
  "down", "outage", "laggy", "lag", "timeout", "slow", "loading forever",
  "keeps failing", "not loading", "wont load", "won't load", "fix this",
  "please fix", "still broken", "broke", "not responding", "500", "404",
];

const FEEDBACK_KEYWORDS = [
  "suggest", "suggestion", "would be nice", "feature request", "please add",
  "can you add", "it would help", "improvement", "improve", "feedback",
  "recommendation", "recommend", "love it", "great job", "well done",
  "amazing", "awesome feature", "bad ux", "confusing", "hard to use",
  "easy to use", "user friendly", "not intuitive", "please consider",
  "you should", "have you considered", "what if", "idea", "ideally",
  "wishlist", "nice to have", "missing feature", "lacks", "needs",
];

// Custom keywords loaded from DB into memory on startup
let customIssueKeywords    = [];
let customFeedbackKeywords = [];

async function loadCustomKeywords() {
  try {
    const { getCustomKeywords } = require("./database");
    const rows = await getCustomKeywords();
    customIssueKeywords    = rows.filter(r => r.category === "issue").map(r => r.keyword);
    customFeedbackKeywords = rows.filter(r => r.category === "feedback").map(r => r.keyword);
    console.log(`📝 Loaded ${customIssueKeywords.length} custom issue keywords, ${customFeedbackKeywords.length} custom feedback keywords`);
  } catch (err) {
    console.error("❌ Failed to load custom keywords:", err.message);
  }
}

function classifyMessage(text) {
  const lower        = text.toLowerCase();
  const allIssues    = [...ISSUE_KEYWORDS,    ...customIssueKeywords];
  const allFeedbacks = [...FEEDBACK_KEYWORDS, ...customFeedbackKeywords];
  if (allIssues.some(kw    => lower.includes(kw))) return "issue";
  if (allFeedbacks.some(kw => lower.includes(kw))) return "feedback";
  return "general";
}

function getAllKeywords() {
  return {
    issue:    { base: ISSUE_KEYWORDS,    custom: customIssueKeywords    },
    feedback: { base: FEEDBACK_KEYWORDS, custom: customFeedbackKeywords },
  };
}

module.exports = { classifyMessage, loadCustomKeywords, getAllKeywords };