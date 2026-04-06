const Anthropic = require("@anthropic-ai/sdk");

let _anthropic = null;
function getClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

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

// ─── Spam Patterns ────────────────────────────────────────────────────────────
// Messages matching any of these are ignored entirely — never tracked
const SPAM_PATTERNS = [
  /terabox/i,
  /sign.?up.*watch/i,
  /full.*movie.*download/i,
  /download.*movie/i,
  /480p|720p|1080p/i,
  /➠|➤|➥/,                          // common spam arrow chars
  /t\.me\/\S+/i,                     // Telegram invite links
  /bit\.ly|tinyurl|shorturl/i,       // link shorteners
  /earn \$\d+|make money|passive income/i,
  /free.*crypto|airdrop.*claim/i,
  /click here.*link|link.*click here/i,
  /\b(porn|xxx|adult|nude|sex)\b/i,  // adult content
  /casino|gambling|betting site/i,
  /whatsapp.*group.*join|join.*whatsapp/i,

  // Spaced-out character spam (e.g. "E T H 神 級 預 判" or "不 賺 都 他 媽")
  /(?:^|[\s\uFEFF])(\S) \1|\b(\S) (\S) (\S) \4/u,  // repeated spaced chars
  /(\S ){4,}\S/,                     // 5+ single chars each separated by a space

  // Crypto price-prediction & signal spam
  /神.*級.*預.*判|預.*判.*神|信號.*群|喊單|跟單/u,  // Chinese trading signal spam
  /\b(eth|btc|sol|bnb)\b.*神|神.*(eth|btc|sol|bnb)\b/iu,

  // Promotional @CamelCase account spam (e.g. @BitTapGloba, @CryptoAlphaBot)
  /@[A-Z][a-z]{2,}[A-Z][a-zA-Z]+/,

  // Same emoji repeated 2+ times at the very start (🎯🎯, 🟥🟥, 🤬🤬 openers)
  /^(\p{Emoji_Presentation})\1/u,

  // CJK character blocks combined with profit/trading keywords
  /[\u4e00-\u9fff]{2,}.{0,20}(赚|躺|稳|绿色|项目|群)/u,
];

/** Returns true if the message looks like spam and should be ignored */
function isSpam(text) {
  const lower = text.toLowerCase();
  // Too many URLs in one message = spam
  const urlCount = (text.match(/https?:\/\/\S+/g) || []).length;
  if (urlCount >= 3) return true;
  // Too many special arrow/bullet chars = spam
  const arrowCount = (text.match(/[➠➤➥►▶→]/g) || []).length;
  if (arrowCount >= 2) return true;
  return SPAM_PATTERNS.some(pattern => pattern.test(text));
}

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

/**
 * Hybrid classifier: keyword check first (free), then Claude Haiku for "general" messages.
 * Falls back to "general" silently on any API error or rate limit.
 */
async function classifyMessageAI(text) {
  const keywordResult = classifyMessage(text);
  if (keywordResult !== "general") return keywordResult;

  try {
    const response = await getClient().messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system:
        "Classify this community message as exactly one word: " +
        "'issue' (complaint, bug, problem, error, confusion, frustration, something not working), " +
        "'feedback' (suggestion, feature request, praise, improvement idea, opinion on UX), " +
        "or 'general' (casual chat, greetings, questions, news, price talk). " +
        "Reply with only that single word, nothing else.",
      messages: [{ role: "user", content: text.slice(0, 500) }],
    });
    const result = response.content[0].text.trim().toLowerCase();
    if (["issue", "feedback", "general"].includes(result)) return result;
    return "general";
  } catch {
    return "general";
  }
}

function getAllKeywords() {
  return {
    issue:    { base: ISSUE_KEYWORDS,    custom: customIssueKeywords    },
    feedback: { base: FEEDBACK_KEYWORDS, custom: customFeedbackKeywords },
  };
}

module.exports = { classifyMessage, classifyMessageAI, loadCustomKeywords, getAllKeywords, isSpam };