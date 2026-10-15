// Builds the activity and language cards shown in the profile README.
// Runs on Node 20+ with no dependencies. Needs GITHUB_TOKEN in the environment.

import { writeFile, mkdir } from "node:fs/promises";

const LOGIN = process.env.PROFILE_LOGIN || "loch214";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = new URL("../assets/", import.meta.url);

if (!TOKEN) {
  console.error("GITHUB_TOKEN is not set");
  process.exit(1);
}

// GitHub's own UI tokens, so the cards sit naturally on the profile page.
const THEMES = {
  light: {
    border: "#d0d7de",
    text: "#1f2328",
    muted: "#656d76",
    grid: "#eaeef2",
    accent: "#2a78d6",
    track: "#eaeef2",
  },
  dark: {
    border: "#30363d",
    text: "#e6edf3",
    muted: "#7d8590",
    grid: "#21262d",
    accent: "#3987e5",
    track: "#21262d",
  },
};

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`;
const WIDTH = 840;

// Languages that are mostly markup, config or generated output. They inflate
// the totals without saying much about what the code is written in.
const IGNORED_LANGUAGES = new Set(["HTML", "CSS", "Batchfile", "PowerShell", "Shell", "Dockerfile"]);
const LANGUAGE_ALIASES = { "Jupyter Notebook": "Python" };

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(JSON.stringify(body.errors || body));
  }
  return body.data;
}

async function fetchData() {
  const data = await graphql(
    `query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount } }
          }
        }
        repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
          nodes {
            name
            languages(first: 20) { edges { size node { name } } }
          }
        }
      }
    }`,
    { login: LOGIN },
  );
  return data.user;
}

// ---------- numbers ----------

function summarizeCalendar(calendar) {
  const days = calendar.weeks.flatMap((w) => w.contributionDays);
  const weeks = calendar.weeks.map((w) => ({
    start: w.contributionDays[0].date,
    count: w.contributionDays.reduce((sum, d) => sum + d.contributionCount, 0),
  }));

  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }

  // A day with nothing yet today shouldn't break the current streak.
  let i = days.length - 1;
  if (days[i].contributionCount === 0) i--;
  let current = 0;
  while (i >= 0 && days[i].contributionCount > 0) {
    current++;
    i--;
  }

  return {
    total: calendar.totalContributions,
    activeDays: days.filter((d) => d.contributionCount > 0).length,
    longest,
    current,
    weeks,
  };
}

// Each repo gets an equal vote, split by how much of it is each language.
// This keeps one repo with a large bundled file from dominating the chart.
function summarizeLanguages(repos) {
  const shares = new Map();
  let repoCount = 0;
  for (const repo of repos) {
    const edges = repo.languages.edges
      .map((e) => ({ name: LANGUAGE_ALIASES[e.node.name] || e.node.name, size: e.size }))
      .filter((e) => !IGNORED_LANGUAGES.has(e.name));
    const total = edges.reduce((sum, e) => sum + e.size, 0);
    if (!total) continue;
    repoCount++;
    for (const e of edges) {
      shares.set(e.name, (shares.get(e.name) || 0) + e.size / total);
    }
  }
  const sorted = [...shares.entries()]
    .map(([name, share]) => ({ name, value: share / repoCount }))
    .sort((a, b) => b.value - a.value);

  const top = sorted.slice(0, 5);
  const rest = sorted.slice(5).reduce((sum, l) => sum + l.value, 0);
  if (rest > 0.005) top.push({ name: "Other", value: rest });
  return top;
}

// ---------- drawing ----------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n) => n.toLocaleString("en-US");
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;

// A bar with its top corners rounded and its base square on the axis.
function bar(x, y, w, h, r) {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `<path d="M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z"/>`;
}

function card(height, body, title, t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${esc(title)}" font-family='${FONT}'>
<title>${esc(title)}</title>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="6" fill="none" stroke="${t.border}"/>
${body}
</svg>
`;
}

function activitySvg(stats, t) {
  const pad = 28;
  const height = 300;

  const stat = (x, label, value) => `
<text x="${x}" y="${pad + 12}" font-size="12" fill="${t.muted}">${esc(label)}</text>
<text x="${x}" y="${pad + 38}" font-size="20" font-weight="600" fill="${t.text}">${esc(value)}</text>`;

  const header = `
<text x="${pad}" y="${pad + 12}" font-size="12" fill="${t.muted}">Contributions in the last year</text>
<text x="${pad}" y="${pad + 46}" font-size="32" font-weight="600" fill="${t.text}">${fmt(stats.total)}</text>
${stat(WIDTH - pad - 420, "Active days", fmt(stats.activeDays))}
${stat(WIDTH - pad - 280, "Longest streak", plural(stats.longest, "day"))}
${stat(WIDTH - pad - 140, "Current streak", plural(stats.current, "day"))}`;

  // Chart area
  const left = pad + 28;
  const right = WIDTH - pad;
  const top = 108;
  const bottom = height - 44;
  const plotH = bottom - top;

  const weeks = stats.weeks;
  const peak = Math.max(1, ...weeks.map((w) => w.count));
  const step = niceStep(peak);
  const yMax = Math.ceil(peak / step) * step;
  const y = (v) => bottom - (v / yMax) * plotH;

  const slot = (right - left) / weeks.length;
  const gap = Math.max(2, slot * 0.28);
  const bw = slot - gap;

  let grid = "";
  for (let v = 0; v <= yMax; v += step) {
    const yy = y(v).toFixed(1);
    grid += `<line x1="${left}" x2="${right}" y1="${yy}" y2="${yy}" stroke="${v === 0 ? t.border : t.grid}" stroke-width="1"/>`;
    grid += `<text x="${left - 8}" y="${yy}" dy="4" font-size="11" fill="${t.muted}" text-anchor="end">${v}</text>`;
  }

  const bars = weeks
    .map((w, i) => bar(left + i * slot + gap / 2, y(w.count), bw, bottom - y(w.count), 2))
    .join("");

  // Label the busiest week only.
  const peakIndex = weeks.findIndex((w) => w.count === peak);
  const peakX = left + peakIndex * slot + slot / 2;
  const peakLabel = `<text x="${peakX.toFixed(1)}" y="${(y(peak) - 6).toFixed(1)}" font-size="11" font-weight="600" fill="${t.text}" text-anchor="middle">${peak}</text>`;

  // Month labels under the first week that starts in each month.
  let months = "";
  let lastMonth = null;
  weeks.forEach((w, i) => {
    const d = new Date(w.start + "T00:00:00Z");
    const m = d.getUTCMonth();
    if (m !== lastMonth) {
      if (lastMonth !== null && i < weeks.length - 2) {
        const label = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
        months += `<text x="${(left + i * slot).toFixed(1)}" y="${bottom + 20}" font-size="11" fill="${t.muted}">${label}</text>`;
      }
      lastMonth = m;
    }
  });

  const body = `${header}
<g>${grid}</g>
<g fill="${t.accent}">${bars}</g>
${peakLabel}
<g>${months}</g>`;

  return card(height, body, `${fmt(stats.total)} contributions in the last year`, t);
}

function niceStep(max) {
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(1, nice * pow);
}

function languagesSvg(langs, t) {
  const pad = 28;
  const cols = 2;
  const rows = Math.ceil(langs.length / cols);
  const rowH = 36;
  const top = pad + 36;
  const height = top + (rows - 1) * rowH + pad;

  const colGap = 48;
  const colW = (WIDTH - pad * 2 - colGap) / cols;
  const nameW = 120;
  const pctW = 44;
  const trackW = colW - nameW - pctW;
  const maxValue = langs[0].value;

  const rowsSvg = langs
    .map((l, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      const x = pad + col * (colW + colGap);
      const yy = top + row * rowH;
      const w = Math.max(3, (l.value / maxValue) * trackW);
      return `
<text x="${x}" y="${yy + 4}" font-size="13" fill="${t.text}">${esc(l.name)}</text>
<rect x="${x + nameW}" y="${yy - 3}" width="${trackW.toFixed(1)}" height="6" rx="3" fill="${t.track}"/>
<rect x="${x + nameW}" y="${yy - 3}" width="${w.toFixed(1)}" height="6" rx="3" fill="${t.accent}"/>
<text x="${x + colW}" y="${yy + 4}" font-size="12" fill="${t.muted}" text-anchor="end">${(l.value * 100).toFixed(1)}%</text>`;
    })
    .join("");

  const body = `
<text x="${pad}" y="${pad + 12}" font-size="12" fill="${t.muted}">Languages across public repositories</text>
${rowsSvg}`;

  return card(height, body, "Languages across public repositories", t);
}

// ---------- main ----------

const user = await fetchData();
const stats = summarizeCalendar(user.contributionsCollection.contributionCalendar);
const langs = summarizeLanguages(user.repositories.nodes);

await mkdir(OUT, { recursive: true });
for (const [mode, theme] of Object.entries(THEMES)) {
  await writeFile(new URL(`activity-${mode}.svg`, OUT), activitySvg(stats, theme));
  await writeFile(new URL(`languages-${mode}.svg`, OUT), languagesSvg(langs, theme));
}

console.log(`${stats.total} contributions, longest streak ${stats.longest}, current ${stats.current}`);
console.log(langs.map((l) => `${l.name} ${(l.value * 100).toFixed(1)}%`).join(", "));
