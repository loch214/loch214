// Builds the cards shown in the profile README.
// Runs on Node 20+ with no dependencies. Needs GITHUB_TOKEN in the environment.

import { readFile, writeFile, mkdir } from "node:fs/promises";

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
    surface: "#ffffff",
  },
  dark: {
    border: "#30363d",
    text: "#e6edf3",
    muted: "#7d8590",
    grid: "#21262d",
    accent: "#3987e5",
    track: "#21262d",
    surface: "#0d1117",
  },
};

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`;
const WIDTH = 840;

// Languages that are mostly markup, config or generated output. They inflate
// the totals without saying much about what the code is written in.
const IGNORED_LANGUAGES = new Set(["HTML", "CSS", "Batchfile", "PowerShell", "Shell", "Dockerfile"]);
const LANGUAGE_ALIASES = { "Jupyter Notebook": "Python" };

// Commit times are shown in this time zone.
const TIME_ZONE = "Asia/Colombo";
const TIME_ZONE_LABEL = "Sri Lanka time";

const EDUCATION = [
  {
    logo: "logos/sliit.png",
    name: "Sri Lanka Institute of Information Technology",
    detail: "BSc (Hons) in Software Engineering",
  },
  {
    logo: "logos/dssc.png",
    name: "D. S. Senanayake College, Colombo",
  },
];

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
        id
        createdAt
        contributionsCollection {
          contributionYears
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalRepositoriesWithContributedCommits
          commitContributionsByRepository(maxRepositories: 100) {
            repository { name isPrivate owner { login } }
            contributions { totalCount }
          }
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount } }
          }
        }
        repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
          totalCount
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

// GitHub only reports contributions one year at a time, so add them up.
async function fetchAllTime(years) {
  const fields = years
    .map(
      (y) => `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") {
        totalCommitContributions
        contributionCalendar { totalContributions }
      }`,
    )
    .join(" ");
  const data = await graphql(`query($login: String!) { user(login: $login) { ${fields} } }`, { login: LOGIN });
  const totals = { contributions: 0, commits: 0 };
  for (const year of Object.values(data.user)) {
    totals.contributions += year.contributionCalendar.totalContributions;
    totals.commits += year.totalCommitContributions;
  }
  return totals;
}

// Author times of every commit in the last year, across public repos the user committed to.
async function fetchCommitTimes(user) {
  const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const repos = user.contributionsCollection.commitContributionsByRepository
    .filter((r) => !r.repository.isPrivate)
    .map((r) => r.repository);

  const times = [];
  for (const repo of repos) {
    let after = null;
    do {
      const data = await graphql(
        `query($owner: String!, $name: String!, $author: ID!, $since: GitTimestamp!, $after: String) {
          repository(owner: $owner, name: $name) {
            defaultBranchRef {
              target {
                ... on Commit {
                  history(first: 100, after: $after, since: $since, author: { id: $author }) {
                    pageInfo { hasNextPage endCursor }
                    nodes { authoredDate }
                  }
                }
              }
            }
          }
        }`,
        { owner: repo.owner.login, name: repo.name, author: user.id, since, after },
      );
      const history = data.repository?.defaultBranchRef?.target?.history;
      if (!history) break;
      times.push(...history.nodes.map((n) => n.authoredDate));
      after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (after);
  }
  return times;
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

  const sum = (list) => list.reduce((total, d) => total + d.contributionCount, 0);
  const last30 = sum(days.slice(-30));
  const prev30 = sum(days.slice(-60, -30));

  return {
    total: calendar.totalContributions,
    last30,
    prev30,
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

function summarizeStats(user, allTime) {
  const c = user.contributionsCollection;
  const topRepos = c.commitContributionsByRepository
    .filter((r) => !r.repository.isPrivate)
    .slice(0, 5)
    .map((r) => ({
      name: r.repository.owner.login === LOGIN ? r.repository.name : `${r.repository.owner.login}/${r.repository.name}`,
      value: r.contributions.totalCount,
    }));
  return {
    groups: [
      {
        title: "All time",
        figures: [
          ["Contributions", fmt(allTime.contributions)],
          ["Commits", fmt(allTime.commits)],
          ["Public repos", fmt(user.repositories.totalCount)],
        ],
      },
      {
        title: "Last 12 months",
        figures: [
          ["Commits", fmt(c.totalCommitContributions)],
          ["Pull requests", fmt(c.totalPullRequestContributions)],
          ["Issues", fmt(c.totalIssueContributions)],
        ],
      },
    ],
    topRepos,
  };
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function summarizeRhythm(times) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  });
  const dayIndex = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const byDay = new Array(7).fill(0);
  const byHour = new Array(24).fill(0);
  for (const time of times) {
    const p = Object.fromEntries(parts.formatToParts(new Date(time)).map((x) => [x.type, x.value]));
    byDay[dayIndex[p.weekday]]++;
    byHour[Number(p.hour) % 24]++;
  }

  // Busiest three-hour window, wrapping past midnight.
  let bestStart = 0;
  let bestCount = -1;
  for (let h = 0; h < 24; h++) {
    const count = byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24];
    if (count > bestCount) {
      bestCount = count;
      bestStart = h;
    }
  }
  const peakDay = byDay.indexOf(Math.max(...byDay));
  return { total: times.length, byDay, byHour, peakDay, windowStart: bestStart };
}

function hourLabel(h) {
  h = ((h % 24) + 24) % 24;
  if (h === 0) return "12 am";
  if (h === 12) return "12 pm";
  return h < 12 ? `${h} am` : `${h - 12} pm`;
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

function smoothPath(points) {
  const n = points.length;
  if (n < 2) return "";
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push((points[i + 1][1] - points[i][1]) / dx[i]);
  }
  const tangent = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    tangent.push(slope[i - 1] * slope[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) /
      ((2 * dx[i] + dx[i - 1]) / slope[i - 1] + (dx[i] + 2 * dx[i - 1]) / slope[i]));
  }
  tangent.push(slope[n - 2]);

  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h = dx[i] / 3;
    d += `C${(x0 + h).toFixed(1)},${(y0 + h * tangent[i]).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - h * tangent[i + 1]).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
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
  const height = 330;

  // Header: the big total on the left, four figures on the right.
  const statW = 128;
  const stat = (i, label, value, note) => {
    const x = WIDTH - pad - (4 - i) * statW;
    return `
<text x="${x}" y="${pad + 12}" font-size="12" fill="${t.muted}">${esc(label)}</text>
<text x="${x}" y="${pad + 38}" font-size="20" font-weight="600" fill="${t.text}">${esc(value)}</text>${
      note ? `<text x="${x}" y="${pad + 56}" font-size="11" fill="${t.muted}">${esc(note)}</text>` : ""
    }`;
  };

  let change = "";
  if (stats.prev30 > 0) {
    const pct = Math.round(((stats.last30 - stats.prev30) / stats.prev30) * 100);
    change = `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs prior 30 days`;
  } else if (stats.last30 > 0) {
    change = "up from 0 in prior 30 days";
  }

  const header = `
<text x="${pad}" y="${pad + 12}" font-size="12" fill="${t.muted}">Contributions in the last year</text>
<text x="${pad}" y="${pad + 46}" font-size="32" font-weight="600" fill="${t.text}">${fmt(stats.total)}</text>
${stat(0, "Last 30 days", fmt(stats.last30), change)}
${stat(1, "Active days", fmt(stats.activeDays))}
${stat(2, "Longest streak", plural(stats.longest, "day"))}
${stat(3, "Current streak", plural(stats.current, "day"))}`;

  // Chart area
  const left = pad + 28;
  const right = WIDTH - pad;
  const top = 134;
  const bottom = height - 44;
  const plotH = bottom - top;

  const weeks = stats.weeks;
  const avg = weeks.map((_, i) => {
    const span = weeks.slice(Math.max(0, i - 3), i + 1);
    return span.reduce((sum, w) => sum + w.count, 0) / span.length;
  });
  const peak = Math.max(1, ...weeks.map((w) => w.count));
  const step = niceStep(peak);
  const yMax = Math.ceil(peak / step) * step;
  const y = (v) => bottom - (v / yMax) * plotH;
  const x = (i) => left + (i / (weeks.length - 1)) * (right - left);

  let grid = "";
  for (let v = 0; v <= yMax; v += step) {
    const yy = y(v).toFixed(1);
    grid += `<line x1="${left}" x2="${right}" y1="${yy}" y2="${yy}" stroke="${v === 0 ? t.border : t.grid}" stroke-width="1"/>`;
    grid += `<text x="${left - 8}" y="${yy}" dy="4" font-size="11" fill="${t.muted}" text-anchor="end">${v}</text>`;
  }

  const line = smoothPath(weeks.map((w, i) => [x(i), y(w.count)]));
  const area = `${line}L${right},${bottom}L${left},${bottom}Z`;
  const trend = smoothPath(avg.map((v, i) => [x(i), y(v)]));

  const peakIndex = weeks.findIndex((w) => w.count === peak);
  const px = x(peakIndex);
  const py = y(peak);
  const peakDate = new Date(weeks[peakIndex].start + "T00:00:00Z").toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const peakMark = `
<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5" fill="${t.accent}" stroke="${t.surface}" stroke-width="2"/>
<text x="${(px - 10).toFixed(1)}" y="${(py + 4).toFixed(1)}" font-size="11" fill="${t.muted}" text-anchor="end"><tspan font-weight="600" fill="${t.text}">${peak}</tspan>  week of ${peakDate}</text>`;

  // Month labels under the first week that starts in each month.
  let months = "";
  let lastMonth = null;
  weeks.forEach((w, i) => {
    const d = new Date(w.start + "T00:00:00Z");
    const m = d.getUTCMonth();
    if (m !== lastMonth) {
      if (lastMonth !== null && i < weeks.length - 2) {
        const label = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
        months += `<text x="${x(i).toFixed(1)}" y="${bottom + 20}" font-size="11" fill="${t.muted}" text-anchor="middle">${label}</text>`;
      }
      lastMonth = m;
    }
  });

  const legendY = top - 22;
  const legend = `
<line x1="${right - 236}" x2="${right - 220}" y1="${legendY - 4}" y2="${legendY - 4}" stroke="${t.accent}" stroke-width="2"/>
<text x="${right - 214}" y="${legendY}" font-size="11" fill="${t.muted}">Per week</text>
<line x1="${right - 140}" x2="${right - 124}" y1="${legendY - 4}" y2="${legendY - 4}" stroke="${t.muted}" stroke-width="1.5" stroke-dasharray="3 3"/>
<text x="${right - 118}" y="${legendY}" font-size="11" fill="${t.muted}">4-week average</text>`;

  const body = `
<defs>
  <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${t.accent}" stop-opacity="0.28"/>
    <stop offset="1" stop-color="${t.accent}" stop-opacity="0"/>
  </linearGradient>
</defs>
${header}
${legend}
<g>${grid}</g>
<path d="${area}" fill="url(#fill)"/>
<path d="${trend}" fill="none" stroke="${t.muted}" stroke-width="1.5" stroke-dasharray="3 3" stroke-linecap="round"/>
<path d="${line}" fill="none" stroke="${t.accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
${peakMark}
<g>${months}</g>`;

  return card(height, body, `${fmt(stats.total)} contributions in the last year`, t);
}

function rhythmSvg(r, t) {
  const pad = 28;
  const height = 262;
  const top = pad + 92;
  const bottom = height - 44;
  const plotH = bottom - top;

  const windowText = `${hourLabel(r.windowStart)} – ${hourLabel(r.windowStart + 3)}`;
  const header = `
<text x="${pad}" y="${pad + 12}" font-size="12" fill="${t.muted}">When I commit</text>
<text x="${pad}" y="${pad + 38}" font-size="18" font-weight="600" fill="${t.text}">Most active on ${DAY_NAMES[r.peakDay]}s, ${windowText}</text>
<text x="${WIDTH - pad}" y="${pad + 12}" font-size="12" fill="${t.muted}" text-anchor="end">${fmt(r.total)} commits, last 12 months, ${TIME_ZONE_LABEL}</text>`;

  // Bars with the busiest one at full strength and the rest softened.
  const bars = (values, x0, width, labels, isPeak) => {
    const max = Math.max(1, ...values);
    const slot = width / values.length;
    const gap = Math.max(2, slot * 0.3);
    const y = (v) => bottom - (v / max) * plotH;
    let out = "";
    values.forEach((v, i) => {
      const bx = x0 + i * slot + gap / 2;
      const peak = isPeak(i);
      out += `<g fill="${t.accent}" fill-opacity="${peak ? 1 : 0.4}">${bar(bx, y(v), slot - gap, bottom - y(v), 2)}</g>`;
      if (peak && v > 0) {
        out += `<text x="${(bx + (slot - gap) / 2).toFixed(1)}" y="${(y(v) - 6).toFixed(1)}" font-size="11" font-weight="600" fill="${t.text}" text-anchor="middle">${v}</text>`;
      }
      if (labels[i]) {
        out += `<text x="${(x0 + i * slot + slot / 2).toFixed(1)}" y="${bottom + 18}" font-size="11" fill="${t.muted}" text-anchor="middle">${labels[i]}</text>`;
      }
    });
    out += `<line x1="${x0}" x2="${x0 + width}" y1="${bottom}" y2="${bottom}" stroke="${t.border}"/>`;
    return out;
  };

  const dayW = 230;
  const hourX = pad + dayW + 56;
  const hourW = WIDTH - pad - hourX;
  const dayLabels = DAY_NAMES.map((d) => d.slice(0, 3));
  const hourLabels = r.byHour.map((_, h) => (h % 6 === 0 ? hourLabel(h) : ""));
  const inWindow = (h) => (h - r.windowStart + 24) % 24 < 3;

  const body = `
${header}
<text x="${pad}" y="${top - 22}" font-size="12" fill="${t.muted}">By day of week</text>
<text x="${hourX}" y="${top - 22}" font-size="12" fill="${t.muted}">By hour of day</text>
${bars(r.byDay, pad, dayW, dayLabels, (i) => i === r.peakDay)}
${bars(r.byHour, hourX, hourW, hourLabels, inWindow)}`;

  return card(height, body, `Most active on ${DAY_NAMES[r.peakDay]}s, ${windowText}`, t);
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

function statsSvg(stats, t) {
  const pad = 28;
  const groupH = 94;
  const top = pad + 12;
  const height = top + stats.groups.length * groupH + pad - 18;

  // Left half: figures grouped by time span, three to a row.
  const half = (WIDTH - pad * 2 - 48) / 2;
  const colW = half / 3;
  const figures = stats.groups
    .map((g, gi) => {
      const y = top + gi * groupH;
      const items = g.figures
        .map(([label, value], i) => {
          const x = pad + i * colW;
          return `
<text x="${x}" y="${y + 24}" font-size="12" fill="${t.muted}">${esc(label)}</text>
<text x="${x}" y="${y + 50}" font-size="20" font-weight="600" fill="${t.text}">${esc(value)}</text>`;
        })
        .join("");
      return `
<text x="${pad}" y="${y}" font-size="12" font-weight="600" fill="${t.text}">${esc(g.title)}</text>${items}`;
    })
    .join("");

  // Right half: most active repositories by commits.
  const rx = pad + half + 48;
  const nameW = 190;
  const countW = 36;
  const trackW = half - nameW - countW;
  const max = Math.max(1, ...stats.topRepos.map((r) => r.value));
  const listTop = top + 28;
  const listGap = (height - pad - 4 - listTop) / Math.max(1, stats.topRepos.length - 1);
  const repos = stats.topRepos
    .map((r, i) => {
      const y = listTop + i * listGap;
      const w = Math.max(3, (r.value / max) * trackW);
      const name = r.name.length > 26 ? r.name.slice(0, 25) + "…" : r.name;
      return `
<text x="${rx}" y="${y + 4}" font-size="13" fill="${t.text}">${esc(name)}</text>
<rect x="${rx + nameW}" y="${y - 3}" width="${trackW.toFixed(1)}" height="6" rx="3" fill="${t.track}"/>
<rect x="${rx + nameW}" y="${y - 3}" width="${w.toFixed(1)}" height="6" rx="3" fill="${t.accent}"/>
<text x="${rx + half}" y="${y + 4}" font-size="12" fill="${t.muted}" text-anchor="end">${fmt(r.value)}</text>`;
    })
    .join("");

  const divider = `<line x1="${pad + half + 24}" x2="${pad + half + 24}" y1="${pad}" y2="${height - pad}" stroke="${t.grid}"/>`;

  const body = `
<text x="${rx}" y="${top}" font-size="12" font-weight="600" fill="${t.text}">Most active repositories</text>
<text x="${rx + half}" y="${top}" font-size="12" fill="${t.muted}" text-anchor="end">commits, last 12 months</text>
${divider}
${figures}
${repos}`;

  return card(height, body, "GitHub stats", t);
}

function educationSvg(schools, t) {
  const pad = 28;
  const tile = 52;
  const gap = 16;
  const top = pad + 30;
  const height = top + schools.length * tile + (schools.length - 1) * gap + pad;

  const items = schools
    .map((s, i) => {
      const x = pad;
      const y = top + i * (tile + gap);
      const textX = x + tile + 16;
      return `
<rect x="${x + 0.5}" y="${y + 0.5}" width="${tile - 1}" height="${tile - 1}" rx="8" fill="#ffffff" stroke="${t.border}"/>
<image x="${x + 6}" y="${y + 6}" width="${tile - 12}" height="${tile - 12}" href="${s.dataUri}" preserveAspectRatio="xMidYMid meet"/>
<text x="${textX}" y="${y + (s.detail ? 22 : 31)}" font-size="14" font-weight="600" fill="${t.text}">${esc(s.name)}</text>${
        s.detail ? `
<text x="${textX}" y="${y + 40}" font-size="12" fill="${t.muted}">${esc(s.detail)}</text>` : ""
      }`;
    })
    .join("");

  const body = `
<text x="${pad}" y="${pad + 12}" font-size="12" fill="${t.muted}">Education</text>
${items}`;

  return card(height, body, "Education: " + schools.map((s) => s.name).join(", "), t);
}

// ---------- main ----------

const user = await fetchData();
const stats = summarizeCalendar(user.contributionsCollection.contributionCalendar);
const langs = summarizeLanguages(user.repositories.nodes);
const allTime = await fetchAllTime(user.contributionsCollection.contributionYears);
const ghStats = summarizeStats(user, allTime);
const rhythm = summarizeRhythm(await fetchCommitTimes(user));
const schools = await Promise.all(
  EDUCATION.map(async (s) => ({
    ...s,
    dataUri: "data:image/png;base64," + (await readFile(new URL(s.logo, OUT))).toString("base64"),
  })),
);

await mkdir(OUT, { recursive: true });
for (const [mode, theme] of Object.entries(THEMES)) {
  await writeFile(new URL(`activity-${mode}.svg`, OUT), activitySvg(stats, theme));
  await writeFile(new URL(`rhythm-${mode}.svg`, OUT), rhythmSvg(rhythm, theme));
  await writeFile(new URL(`languages-${mode}.svg`, OUT), languagesSvg(langs, theme));
  await writeFile(new URL(`stats-${mode}.svg`, OUT), statsSvg(ghStats, theme));
  await writeFile(new URL(`education-${mode}.svg`, OUT), educationSvg(schools, theme));
}

console.log(`${rhythm.total} commits timed, peak ${DAY_NAMES[rhythm.peakDay]} ${hourLabel(rhythm.windowStart)}`);
console.log(`${stats.total} contributions, longest streak ${stats.longest}, current ${stats.current}`);
console.log(langs.map((l) => `${l.name} ${(l.value * 100).toFixed(1)}%`).join(", "));
