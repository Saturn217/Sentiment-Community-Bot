const Sentiment = require("sentiment");
const analyzer = new Sentiment();

/**
 * Analyze the sentiment of a text string.
 * Returns a normalized score and a label.
 *
 * Score ranges (comparative):
 *   > 0.05  → positive
 *   < -0.05 → negative
 *   else    → neutral
 */
function analyzeSentiment(text) {
  const result = analyzer.analyze(text);

  // `comparative` normalizes score by word count so short/long messages are fair
  const score = result.comparative;

  let label;
  if (score > 0.05)       label = "positive";
  else if (score < -0.05) label = "negative";
  else                    label = "neutral";

  return {
    score,
    label,
    positiveWords: result.positive,
    negativeWords: result.negative,
  };
}

module.exports = { analyzeSentiment };