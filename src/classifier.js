/**
 * Classifies a message as sentiment + category (issue, feedback, general)
 * and extracts a short summary of what the message is about.
 */

// ─── Keyword Lists ────────────────────────────────────────────────────────────

const ISSUE_KEYWORDS = [
  // Bug/error signals
  "bug", "error", "broken", "not working", "doesnt work", "doesn't work",
  "cant login", "can't login", "unable to", "failed", "crash", "crashes",
  "crashing", "issue", "problem", "glitch", "freeze", "freezing", "stuck",
  "down", "outage", "laggy", "lag", "timeout", "slow", "loading forever",
  "keeps failing", "not loading", "wont load", "won't load", "fix this",
  "please fix", "still broken", "broke", "not responding", "500", "404",
];

const FEEDBACK_KEYWORDS = [
  // Suggestions/opinions
  "suggest", "suggestion", "would be nice", "feature request", "please add",
  "can you add", "it would help", "improvement", "improve", "feedback",
  "recommendation", "recommend", "love it", "great job", "well done",
  "amazing", "awesome feature", "bad ux", "confusing", "hard to use",
  "easy to use", "user friendly", "not intuitive", "please consider",
  "you should", "have you considered", "what if", "idea", "ideally",
  "wishlist", "nice to have", "missing feature", "lacks", "needs",
];

/**
 * Classify a message into a category.
 * Returns: "issue" | "feedback" | "general"
 */
function classifyMessage(text) {
  const lower = text.toLowerCase();

  const isIssue    = ISSUE_KEYWORDS.some((kw) => lower.includes(kw));
  const isFeedback = FEEDBACK_KEYWORDS.some((kw) => lower.includes(kw));

  if (isIssue)    return "issue";
  if (isFeedback) return "feedback";
  return "general";
}

module.exports = { classifyMessage };