const https = require("https");
const { getDailyVolumeByPlatform } = require("./database");

// Colour palette — one per community/platform combo
const COLORS = [
  "#5865f2", // Discord blue
  "#0088cc", // Telegram blue
  "#26a69a", // teal
  "#ef5350", // red
  "#ab47bc", // purple
  "#ffa726", // orange
];

/**
 * Build a QuickChart.io URL for a daily message volume line chart.
 * @param {number} days - how many days back to show (default 30)
 * @returns {Promise<string>} the chart image URL
 */
async function buildVolumeChartUrl(days = 30) {
  const rows = await getDailyVolumeByPlatform(days);
  if (!rows.length) return null;

  // Build sorted list of unique dates as labels
  const dateSet = [...new Set(rows.map(r => String(r.date)))].sort();
  const labels  = dateSet.map(d =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  );

  // Group by community
  const communities = [...new Map(rows.map(r => [`${r.community}|${r.platform}`, r])).values()]
    .map(r => ({ key: `${r.community}|${r.platform}`, label: r.community, platform: r.platform }));

  const datasets = communities.map(({ key, label, platform }, i) => {
    const plat  = platform === "telegram" ? "📱" : "💬";
    const data  = dateSet.map(d => {
      const row = rows.find(r => String(r.date) === d && `${r.community}|${r.platform}` === key);
      return row ? row.message_count : 0;
    });
    return {
      label:           `${plat} ${label}`,
      data,
      borderColor:     COLORS[i % COLORS.length],
      backgroundColor: COLORS[i % COLORS.length] + "33", // 20% opacity fill
      borderWidth:     2,
      pointRadius:     3,
      fill:            false,
      tension:         0.3,
    };
  });

  // Also add a "Total" dataset
  const totalData = dateSet.map(d =>
    rows.filter(r => String(r.date) === d).reduce((s, r) => s + r.message_count, 0)
  );
  datasets.unshift({
    label:           "📊 Total",
    data:            totalData,
    borderColor:     "#ffffff",
    backgroundColor: "#ffffff22",
    borderWidth:     2.5,
    pointRadius:     3,
    fill:            false,
    tension:         0.3,
    borderDash:      [5, 3],
  });

  const chart = {
    type: "line",
    data: { labels, datasets },
    options: {
      plugins: {
        legend: { labels: { color: "#e0e0e0", font: { size: 12 } } },
        title: {
          display: true,
          text:    `Daily Message Volume — Last ${days} Days`,
          color:   "#ffffff",
          font:    { size: 16 },
        },
      },
      scales: {
        x: {
          ticks: { color: "#b0b0b0", maxRotation: 45, font: { size: 10 } },
          grid:  { color: "#333333" },
        },
        y: {
          ticks:    { color: "#b0b0b0" },
          grid:     { color: "#333333" },
          beginAtZero: true,
        },
      },
      backgroundColor: "#1e1e2e",
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chart));
  return `https://quickchart.io/chart?c=${encoded}&w=900&h=450&bkg=%231e1e2e&f=png`;
}

/**
 * Fetch the chart image and return it as a Buffer (for Telegram sendPhoto).
 */
function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

module.exports = { buildVolumeChartUrl, fetchImageBuffer };
