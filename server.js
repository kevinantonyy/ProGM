require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const session = require("express-session");

const app = express();

const {
  YAHOO_CLIENT_ID,
  YAHOO_CLIENT_SECRET,
  YAHOO_REDIRECT_URI,
  FANTASYNERDS_API_KEY,
  PORT = 3000,
  SESSION_SECRET = "dev_secret"
} = process.env;

app.set("trust proxy", 1);
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, sameSite: "lax" }
  })
);
app.use(express.static(path.join(__dirname, "public")));

const YAHOO_FANTASY_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";
const YAHOO_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const SUPPORTED_SPORTS = {
  nba: { label: "Fantasy Basketball", icon: "🏀" },
  nfl: { label: "Fantasy Football", icon: "🏈" }
};

function getAuthHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function expertOverrides() {
  return safeReadJson(path.join(__dirname, "data", "expertOverrides.json"), { players: {} });
}

function toArrayLikeObjectEntries(node) {
  if (!node || typeof node !== "object") return [];
  return Object.keys(node)
    .filter((k) => k !== "count")
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => node[k]);
}

function normalizeName(raw) {
  return String(raw || "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function valueOr(obj, keys, fallback = null) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return fallback;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}


function walkObjects(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  if (Array.isArray(node)) {
    for (const item of node) walkObjects(item, visit);
  } else {
    for (const value of Object.values(node)) walkObjects(value, visit);
  }
}

function firstDeepValue(node, key) {
  let found;
  walkObjects(node, (obj) => {
    if (found === undefined && Object.prototype.hasOwnProperty.call(obj, key)) found = obj[key];
  });
  return found;
}

function parseLeagueSettings(raw, sport) {
  const rosterMap = new Map();
  const statNames = new Map();
  const statValues = new Map();

  walkObjects(raw, (obj) => {
    if (obj.position && obj.count !== undefined) {
      const pos = String(obj.position).toUpperCase();
      const count = Number(obj.count || 0);
      if (pos && count > 0 && count < 30) rosterMap.set(pos, Math.max(rosterMap.get(pos) || 0, count));
    }
    if (obj.stat_id !== undefined && (obj.display_name || obj.name)) {
      statNames.set(String(obj.stat_id), String(obj.display_name || obj.name));
    }
    if (obj.stat_id !== undefined && obj.value !== undefined && Number.isFinite(Number(obj.value))) {
      statValues.set(String(obj.stat_id), Number(obj.value));
    }
  });

  const statModifiers = [...statValues.entries()].map(([id, value]) => ({
    stat_id: id,
    name: statNames.get(id) || `Stat ${id}`,
    value
  }));

  let receptionPoints = 0;
  for (const stat of statModifiers) {
    if (/reception/i.test(stat.name) && !/return/i.test(stat.name)) receptionPoints = stat.value;
  }

  const hasSuperflex = [...rosterMap.keys()].some((p) => ["Q/W/R/T", "SUPERFLEX", "OP"].includes(p));
  let scoringFormat = "std";
  if (sport === "nfl") {
    if (hasSuperflex) scoringFormat = "superflex";
    else if (receptionPoints >= 0.75) scoringFormat = "ppr";
    else if (receptionPoints >= 0.25) scoringFormat = "half";
  }

  return {
    scoringType: String(firstDeepValue(raw, "scoring_type") || ""),
    usesPlayoffs: firstDeepValue(raw, "uses_playoff") ?? firstDeepValue(raw, "uses_playoffs") ?? null,
    teamCount: Number(firstDeepValue(raw, "num_teams") || 0) || null,
    rosterPositions: [...rosterMap.entries()].map(([position, count]) => ({ position, count })),
    statModifiers,
    receptionPoints,
    scoringFormat,
    source: "Yahoo Fantasy league settings"
  };
}

function countRosterPositions(players) {
  const out = {};
  for (const p of players || []) {
    const positions = String(p.display_position || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
    for (const pos of positions) out[pos] = (out[pos] || 0) + 1;
  }
  return out;
}

function rosterNeedScore(player, rosterPlayers, leagueSettings, sport) {
  if (sport !== "nfl") return 0;
  const counts = countRosterPositions(rosterPlayers);
  const positions = String(player.display_position || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  let best = 0;
  for (const pos of positions) {
    const configured = (leagueSettings.rosterPositions || []).find((r) => r.position === pos);
    if (!configured) continue;
    const have = counts[pos] || 0;
    if (have < configured.count) best = Math.max(best, 18);
    else if (have === configured.count) best = Math.max(best, 8);
  }
  return best;
}

function buildDraftSuggestions(availablePlayers, rosterPlayers, context, sport, leagueSettings) {
  const scored = availablePlayers.map((p) => sport === "nfl" ? scoreFootballPlayer(p, context) : scoreBasketballPlayer(p, context));
  return scored.map((p) => {
    const need = rosterNeedScore(p, rosterPlayers, leagueSettings, sport);
    const draftRank = sport === "nfl" ? Number(p.draftRank || p.weeklyRank || 9999) : 9999;
    const rankBonus = sport === "nfl" && draftRank < 9999 ? Math.max(0, 180 - draftRank) / 4 : 0;
    const draftValue = Number((p.score + need + rankBonus).toFixed(2));
    const reasons = [];
    if (need >= 18) reasons.push("fills an open starting-position need");
    else if (need > 0) reasons.push("adds useful depth at a required position");
    if (sport === "nfl" && draftRank < 9999) reasons.push(`expert draft rank ${draftRank}`);
    if (p.projectionPoints) reasons.push(`${p.projectionPoints} projected points`);
    if (!reasons.length) reasons.push("best blended value still available");
    return {
      player_key: p.player_key,
      name: p.name,
      team: p.editorial_team_abbr,
      position: p.display_position,
      projectionPoints: p.projectionPoints || 0,
      expertRank: draftRank < 9999 ? draftRank : null,
      adp: p.adp || null,
      tier: p.tier || null,
      byeWeek: p.byeWeek || null,
      draftValue,
      rosterNeed: need,
      reason: reasons.join(" · "),
      sources: ["Yahoo Fantasy", "FantasyNerds consensus"]
    };
  }).sort((a, b) => b.draftValue - a.draftValue).slice(0, 12);
}

function sourceBreakdownForPlayer(player, sport) {
  if (sport === "nfl") {
    return [
      { label: "Expert consensus", value: player.weeklyRank && player.weeklyRank < 9999 ? `#${player.weeklyRank}` : "—" },
      { label: "Projection", value: player.projectionPoints ? `${player.projectionPoints} pts` : "—" },
      { label: "Opponent", value: player.opponent || "—" },
      { label: "Availability trend", value: `${player.adds || 0} adds / ${player.drops || 0} drops` }
    ];
  }
  return [
    { label: "Projection", value: player.projectionPoints ? `${player.projectionPoints}` : "—" },
    { label: "Player rater", value: player.playerRaterRank < 9999 ? `#${player.playerRaterRank}` : "—" },
    { label: "Games next 7", value: String(player.gamesNext7 || 0) }
  ];
}

function parseYahooPlayer(playerWrapper) {
  const arr = playerWrapper?.player?.[0];
  if (!Array.isArray(arr)) return null;

  const player = {
    player_key: "",
    player_id: "",
    name: "",
    editorial_team_abbr: "",
    display_position: "",
    selected_position: "",
    status: "",
    injury_note: "",
    uniform_number: "",
    bye_weeks: "",
    image_url: ""
  };

  let first = "";
  let last = "";

  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    if (item.player_key) player.player_key = String(item.player_key);
    if (item.player_id) player.player_id = String(item.player_id);
    if (item.name?.full) player.name = item.name.full;
    if (item.name?.first) first = item.name.first;
    if (item.name?.last) last = item.name.last;
    if (item.editorial_team_abbr) player.editorial_team_abbr = item.editorial_team_abbr;
    if (item.display_position) player.display_position = item.display_position;
    if (item.selected_position?.position) player.selected_position = item.selected_position.position;
    if (item.status) player.status = item.status;
    if (item.injury_note) player.injury_note = item.injury_note;
    if (item.uniform_number) player.uniform_number = item.uniform_number;
    if (item.bye_weeks?.week) player.bye_weeks = item.bye_weeks.week;
    if (item.image_url) player.image_url = item.image_url;
  }

  if (!player.name) player.name = [first, last].filter(Boolean).join(" ").trim();
  return player;
}

function parseYahooTeam(wrappedTeam, sport) {
  const outerTeamArray = wrappedTeam?.team?.[0];
  if (!Array.isArray(outerTeamArray)) return null;

  let team_key = "";
  let team_id = "";
  let name = "Yahoo Team";
  let url = "";
  let league_scoring_type = "";
  let number_of_moves = "";
  let number_of_trades = "";
  let league_key = "";

  for (const item of outerTeamArray) {
    if (!item || typeof item !== "object") continue;
    if (item.team_key) {
      team_key = String(item.team_key);
      const match = team_key.match(/^([^.]+\.l\.\d+)\.t\.\d+$/);
      if (match) league_key = match[1];
    }
    if (item.team_id) team_id = String(item.team_id);
    if (item.name) name = item.name;
    if (item.url) url = item.url;
    if (item.league_scoring_type) league_scoring_type = item.league_scoring_type;
    if (item.number_of_moves !== undefined) number_of_moves = item.number_of_moves;
    if (item.number_of_trades !== undefined) number_of_trades = item.number_of_trades;
  }

  return {
    team_key,
    team_id,
    league_key,
    name,
    url,
    sport,
    sport_label: SUPPORTED_SPORTS[sport]?.label || sport,
    sport_icon: SUPPORTED_SPORTS[sport]?.icon || "",
    league_name: `Yahoo ${SUPPORTED_SPORTS[sport]?.label || sport}`,
    league_scoring_type,
    number_of_moves,
    number_of_trades
  };
}

function parseTeamsFromUserGames(raw, sport) {
  const games = raw?.fantasy_content?.users?.["0"]?.user?.[1]?.games;
  const teams = [];

  for (const gameWrapper of toArrayLikeObjectEntries(games)) {
    const game = gameWrapper?.game;
    if (!Array.isArray(game)) continue;
    const teamsNode = game?.[1]?.teams;
    for (const teamNode of toArrayLikeObjectEntries(teamsNode)) {
      const parsed = parseYahooTeam(teamNode, sport);
      if (parsed?.team_key) teams.push(parsed);
    }
  }

  return teams;
}

function parseLeagueTeams(raw, sport) {
  const teamsNode = raw?.fantasy_content?.league?.[1]?.teams;
  return toArrayLikeObjectEntries(teamsNode)
    .map((teamNode) => parseYahooTeam(teamNode, sport))
    .filter((team) => team?.team_key);
}

async function refreshYahooToken(req) {
  if (!req.session.refreshToken) throw new Error("Yahoo refresh token is unavailable. Reconnect Yahoo.");

  const basicAuth = Buffer.from(`${YAHOO_CLIENT_ID}:${YAHOO_CLIENT_SECRET}`).toString("base64");
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("redirect_uri", YAHOO_REDIRECT_URI);
  params.append("refresh_token", req.session.refreshToken);

  const tokenRes = await axios.post(YAHOO_TOKEN_URL, params.toString(), {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  req.session.accessToken = tokenRes.data.access_token;
  if (tokenRes.data.refresh_token) req.session.refreshToken = tokenRes.data.refresh_token;
  req.session.tokenExpiresAt = Date.now() + Math.max(0, Number(tokenRes.data.expires_in || 3600) - 60) * 1000;
  return req.session.accessToken;
}

async function getValidYahooToken(req) {
  if (!req.session.accessToken) throw Object.assign(new Error("Not connected to Yahoo."), { statusCode: 401 });
  if (req.session.tokenExpiresAt && Date.now() >= req.session.tokenExpiresAt && req.session.refreshToken) {
    return refreshYahooToken(req);
  }
  return req.session.accessToken;
}

async function yahooRequest(req, config) {
  let token = await getValidYahooToken(req);
  const run = (accessToken) =>
    axios({
      ...config,
      headers: { ...(config.headers || {}), ...getAuthHeaders(accessToken) }
    });

  try {
    return await run(token);
  } catch (err) {
    if (err.response?.status === 401 && req.session.refreshToken) {
      token = await refreshYahooToken(req);
      return run(token);
    }
    throw err;
  }
}

async function yahooGet(req, url) {
  const res = await yahooRequest(req, { method: "GET", url });
  return res.data;
}

async function fantasyNerdsGet(sport, endpoint, params = {}) {
  const url = `https://api.fantasynerds.com/v1/${sport}/${endpoint}`;
  const res = await axios.get(url, {
    params: { apikey: FANTASYNERDS_API_KEY, ...params },
    timeout: 12000
  });
  return res.data;
}

function unwrapArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  const commonKeys = [
    "data", "players", "Players", "rankings", "Rankings", "projections", "Projections",
    "News", "news", "Schedule", "schedule", "Injuries", "injuries", "Byes", "byes",
    "AddsDrops", "add_drops", "addDrops", "Lineups", "lineups"
  ];
  for (const key of commonKeys) {
    if (Array.isArray(data[key])) return data[key];
  }

  for (const value of Object.values(data)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function buildBasketballExternalMaps(external) {
  const playersMap = new Map();
  const starterNames = new Set();
  const gamesByTeam = {};

  function upsert(rawName, patch) {
    const key = normalizeName(rawName);
    if (!key) return;
    playersMap.set(key, { ...(playersMap.get(key) || {}), ...patch });
  }

  for (const p of external.projections || []) {
    upsert(valueOr(p, ["display_name", "name", "player_name", "full_name"]), {
      projectionPoints: Number(valueOr(p, ["fantasy_points", "proj_points", "proj_pts", "points", "fp"], 0)) || 0,
      team: valueOr(p, ["team", "team_code", "editorial_team_abbr"])
    });
  }
  for (const p of external.rater || []) {
    upsert(valueOr(p, ["display_name", "name", "player_name", "full_name"]), {
      playerRaterRank: Number(valueOr(p, ["rank", "overall_rank", "player_rank"], 9999)) || 9999,
      playerRaterPoints: Number(valueOr(p, ["fantasy_points", "points", "fp"], 0)) || 0
    });
  }
  for (const p of external.injuries || []) {
    upsert(valueOr(p, ["display_name", "name", "player_name", "full_name"]), {
      injuryStatus: valueOr(p, ["status", "injury_status"], ""),
      injuryNote: valueOr(p, ["injury", "note", "description"], "")
    });
  }
  for (const l of external.lineups || []) {
    for (const [k, v] of Object.entries(l || {})) {
      if (typeof v === "string" && k.toLowerCase().includes("name")) starterNames.add(normalizeName(v));
    }
  }

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + 7);
  for (const g of external.schedule || []) {
    const rawDate = valueOr(g, ["date", "game_date", "scheduled"]);
    const away = valueOr(g, ["away_team", "away", "visitor"]);
    const home = valueOr(g, ["home_team", "home"]);
    if (!rawDate || !away || !home) continue;
    const dt = new Date(rawDate);
    if (Number.isNaN(dt.getTime()) || dt < now || dt > cutoff) continue;
    gamesByTeam[away] = (gamesByTeam[away] || 0) + 1;
    gamesByTeam[home] = (gamesByTeam[home] || 0) + 1;
  }

  return { playersMap, starterNames, gamesByTeam };
}

function buildFootballExternalMaps(external) {
  const playersMap = new Map();
  const byeByTeam = {};
  const addDropByName = new Map();

  function upsert(rawName, patch) {
    const key = normalizeName(rawName);
    if (!key) return;
    playersMap.set(key, { ...(playersMap.get(key) || {}), ...patch });
  }

  for (const p of external.weeklyRankings || []) {
    const name = valueOr(p, ["display_name", "name", "player_name", "full_name"]);
    upsert(name, {
      projectionPoints: Number(valueOr(p, ["proj_pts_ppr", "proj_pts", "projected_points", "fantasy_points", "points"], 0)) || 0,
      weeklyRank: Number(valueOr(p, ["rank", "overall_rank", "rank_position"], 9999)) || 9999,
      position: valueOr(p, ["position", "pos"], ""),
      team: valueOr(p, ["team", "team_code", "editorial_team_abbr"], ""),
      opponent: valueOr(p, ["opponent", "opp"], "")
    });
  }

  for (const p of external.weeklyProjections || []) {
    const name = valueOr(p, ["display_name", "name", "player_name", "full_name"]);
    const current = playersMap.get(normalizeName(name)) || {};
    upsert(name, {
      projectionPoints: Number(valueOr(p, ["proj_pts_ppr", "proj_pts", "projected_points", "fantasy_points", "points"], current.projectionPoints || 0)) || 0,
      position: valueOr(p, ["position", "pos"], current.position || ""),
      team: valueOr(p, ["team", "team_code", "editorial_team_abbr"], current.team || ""),
      opponent: valueOr(p, ["opponent", "opp"], current.opponent || "")
    });
  }

  for (const p of external.ros || []) {
    upsert(valueOr(p, ["display_name", "name", "player_name", "full_name"]), {
      rosProjection: Number(valueOr(p, ["fantasy_points", "points", "proj_pts", "projected_points"], 0)) || 0,
      rosRank: Number(valueOr(p, ["rank", "overall_rank"], 9999)) || 9999
    });
  }

  for (const p of external.draftRankings || []) {
    upsert(valueOr(p, ["display_name", "name", "player_name", "full_name"]), {
      draftRank: Number(valueOr(p, ["rank", "overall_rank", "rank_position"], 9999)) || 9999,
      tier: valueOr(p, ["tier", "player_tier"], null)
    });
  }
  for (const p of external.draftProjections || []) {
    upsert(valueOr(p, ["display_name", "name", "player_name", "full_name"]), {
      draftProjection: Number(valueOr(p, ["fantasy_points", "points", "proj_pts", "projected_points"], 0)) || 0
    });
  }
  for (const p of external.adp || []) {
    upsert(valueOr(p, ["display_name", "name", "player_name", "full_name"]), {
      adp: Number(valueOr(p, ["adp", "overall_adp", "average_draft_position", "rank"], 0)) || 0
    });
  }

  for (const p of external.injuries || []) {
    upsert(valueOr(p, ["display_name", "name", "player_name", "full_name"]), {
      injuryStatus: valueOr(p, ["status", "injury_status"], ""),
      injuryNote: valueOr(p, ["injury", "note", "description"], "")
    });
  }

  for (const p of external.news || []) {
    upsert(valueOr(p, ["display_name", "name", "player_name", "full_name"]), {
      headline: valueOr(p, ["headline", "title"], "")
    });
  }

  for (const b of external.byes || []) {
    const team = valueOr(b, ["team", "team_code", "abbr", "team_abbr"]);
    const week = valueOr(b, ["bye", "bye_week", "week"]);
    if (team && week !== null) byeByTeam[String(team).toUpperCase()] = week;
  }

  for (const p of external.addDrops || []) {
    const name = valueOr(p, ["display_name", "name", "player_name", "full_name"]);
    const key = normalizeName(name);
    if (!key) continue;
    addDropByName.set(key, {
      adds: Number(valueOr(p, ["adds", "add_count", "added"], 0)) || 0,
      drops: Number(valueOr(p, ["drops", "drop_count", "dropped"], 0)) || 0
    });
  }

  return { playersMap, byeByTeam, addDropByName };
}

function overrideValue(v) {
  return typeof v === "number" ? v : 0;
}

function scoreBasketballPlayer(player, context) {
  const overrides = context.overrides.players || {};
  const key = normalizeName(player.name);
  const ext = context.external.playersMap.get(key) || {};
  const isStarterToday = context.external.starterNames.has(key);

  let score = Number(ext.projectionPoints || 0) * 1.2 + Number(ext.playerRaterPoints || 0) * 0.5;
  const rank = Number(ext.playerRaterRank || 9999);
  if (rank < 25) score += 10;
  else if (rank < 60) score += 6;
  else if (rank < 120) score += 3;

  const gamesNext7 = context.external.gamesByTeam[player.editorial_team_abbr] || 0;
  score += gamesNext7 * 4;
  if (isStarterToday) score += 6;
  if (player.selected_position && !["BN", "IL", "IL+"].includes(player.selected_position)) score += 2;
  if (player.status || ext.injuryStatus) score -= 10;
  if (player.injury_note || ext.injuryNote) score -= 5;

  const override = overrides[player.name];
  if (override && typeof override.boost === "number") score += override.boost;

  return {
    ...player,
    sport: "nba",
    projectionPoints: Number(ext.projectionPoints || 0),
    playerRaterPoints: Number(ext.playerRaterPoints || 0),
    playerRaterRank: rank,
    gamesNext7,
    isStarterToday,
    expertBoost: overrideValue(override?.boost),
    expertNote: override?.note || "",
    score: Number(score.toFixed(2))
  };
}

function scoreFootballPlayer(player, context) {
  const key = normalizeName(player.name);
  const ext = context.external.playersMap.get(key) || {};
  const trend = context.external.addDropByName.get(key) || { adds: 0, drops: 0 };
  const team = String(player.editorial_team_abbr || ext.team || "").toUpperCase();
  const projection = Number(ext.projectionPoints || 0);
  const rank = Number(ext.weeklyRank || 9999);
  const isBench = ["BN", "IR"].includes(player.selected_position);

  let score = projection * 4;
  if (rank <= 12) score += 18;
  else if (rank <= 24) score += 13;
  else if (rank <= 50) score += 8;
  else if (rank <= 100) score += 4;

  if (!isBench && player.selected_position) score += 3;
  if (player.status || ext.injuryStatus) score -= 14;
  if (player.injury_note || ext.injuryNote) score -= 5;
  score += Math.min(8, Math.max(-4, (trend.adds - trend.drops) / 1000));

  return {
    ...player,
    sport: "nfl",
    projectionPoints: projection,
    weeklyRank: rank,
    draftRank: Number(ext.draftRank || 9999),
    draftProjection: Number(ext.draftProjection || 0),
    adp: Number(ext.adp || 0),
    rosRank: Number(ext.rosRank || 9999),
    rosProjection: Number(ext.rosProjection || 0),
    tier: ext.tier || null,
    opponent: ext.opponent || "",
    byeWeek: player.bye_weeks || context.external.byeByTeam[team] || "",
    injuryStatus: ext.injuryStatus || "",
    externalInjuryNote: ext.injuryNote || "",
    headline: ext.headline || "",
    adds: trend.adds,
    drops: trend.drops,
    score: Number(score.toFixed(2))
  };
}

function footballPositionsCompatible(benchPlayer, starterPlayer) {
  const bp = String(benchPlayer.display_position || "").split(",").map((s) => s.trim());
  const slot = String(starterPlayer.selected_position || "").toUpperCase();
  if (!slot) return false;
  if (bp.includes(slot)) return true;
  if (["W/R/T", "WR/RB/TE", "FLEX"].includes(slot)) return bp.some((p) => ["RB", "WR", "TE"].includes(p));
  if (["W/R", "WR/RB"].includes(slot)) return bp.some((p) => ["RB", "WR"].includes(p));
  if (["Q/W/R/T", "SUPERFLEX"].includes(slot)) return bp.some((p) => ["QB", "RB", "WR", "TE"].includes(p));
  if (["DEF", "D/ST"].includes(slot)) return bp.some((p) => ["DEF", "D/ST"].includes(p));
  return false;
}

function buildLineupSuggestions(scoredPlayers, sport) {
  const inactiveSlots = sport === "nfl" ? ["BN", "IR"] : ["BN", "IL", "IL+"];
  const starters = scoredPlayers.filter((p) => !inactiveSlots.includes(p.selected_position));
  const bench = scoredPlayers.filter((p) => p.selected_position === "BN").sort((a, b) => b.score - a.score);
  const suggestions = [];

  for (const benchPlayer of bench) {
    const candidates = starters
      .filter((starter) => sport !== "nfl" || footballPositionsCompatible(benchPlayer, starter))
      .sort((a, b) => a.score - b.score);
    const weakest = candidates[0];
    if (weakest && benchPlayer.score > weakest.score + (sport === "nfl" ? 2 : 0)) {
      suggestions.push({
        type: "swap",
        start: benchPlayer,
        bench: weakest,
        text: `Start ${benchPlayer.name} over ${weakest.name}`,
        gain: Number((benchPlayer.score - weakest.score).toFixed(2)),
        reason: `${benchPlayer.name} grades higher in the current expert/projection blend for this league.`,
        evidence: sourceBreakdownForPlayer(benchPlayer, sport),
        sources: ["Yahoo Fantasy league/roster", "FantasyNerds consensus rankings & projections"]
      });
    }
    if (suggestions.length >= 4) break;
  }

  for (const p of scoredPlayers) {
    if (p.status || p.injuryStatus) {
      suggestions.push({
        type: "injury",
        player: p,
        text: `Monitor ${p.name}: ${p.status || p.injuryStatus}`,
        gain: 0,
        reason: p.externalInjuryNote || p.injury_note || "Player has an active injury designation.",
        evidence: sourceBreakdownForPlayer(p, sport),
        sources: ["Yahoo Fantasy injury status", "FantasyNerds injury report"]
      });
    }
  }

  if (!suggestions.length) suggestions.push({
    type: "hold",
    text: "No lineup change clears the recommendation threshold.",
    gain: 0,
    reason: "Your current starters grade at least as well as compatible bench options.",
    evidence: [],
    sources: ["Yahoo Fantasy league/roster", "FantasyNerds consensus rankings & projections"]
  });
  return suggestions.slice(0, 8);
}

function buildTradeIdeas(scoredPlayers, sport) {
  const inactiveSlots = sport === "nfl" ? ["BN", "IR"] : ["BN", "IL", "IL+"];
  const sorted = [...scoredPlayers].sort((a, b) => b.score - a.score);
  const starters = sorted.filter((p) => !inactiveSlots.includes(p.selected_position));
  const bench = sorted.filter((p) => p.selected_position === "BN");
  const ideas = [];

  if (bench.length) ideas.push({ text: `Use ${bench[0].name} as a sweetener in a 2-for-1 upgrade.`, value: bench[0].score });
  if (starters.length) {
    const weakest = [...starters].sort((a, b) => a.score - b.score)[0];
    ideas.push({ text: `Consider shopping ${weakest.name} if you can turn the roster spot into a stronger weekly starter.`, value: weakest.score });
  }
  if (sorted.length >= 2) ideas.push({ text: `Core hold tier: ${sorted[0].name}, ${sorted[1].name}.`, value: sorted[0].score });
  return ideas;
}

function buildWaiverSuggestions(availablePlayers, rosterPlayers, context, sport) {
  const scored = availablePlayers.map((p) =>
    sport === "nfl" ? scoreFootballPlayer(p, context) : scoreBasketballPlayer(p, context)
  );

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((p) => {
      const samePosition = rosterPlayers
        .filter((r) => sport !== "nfl" || footballPositionsCompatible(p, { selected_position: r.display_position }))
        .sort((a, b) => a.score - b.score)[0];
      const worstRoster = samePosition || [...rosterPlayers].sort((a, b) => a.score - b.score)[0];
      const upgrade = worstRoster ? Number((p.score - worstRoster.score).toFixed(2)) : null;
      return {
        player_key: p.player_key,
        name: p.name,
        display_position: p.display_position,
        editorial_team_abbr: p.editorial_team_abbr,
        score: p.score,
        projectionPoints: p.projectionPoints,
        weeklyRank: p.weeklyRank,
        byeWeek: p.byeWeek,
        reason: worstRoster
          ? `${upgrade >= 0 ? "Potential upgrade" : "Depth option"}: ${upgrade} model points vs. ${worstRoster.name}.`
          : "Best available fit by blended score."
      };
    });
}


function primaryPosition(player) {
  const parts = String(player.display_position || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  return parts[0] || "UTIL";
}

function buildLeagueTradeSuggestions(myRoster, opponentTeams, sport) {
  const myPlayers = [...myRoster].filter((p) => !["IR", "IL", "IL+"].includes(p.selected_position));
  const myByPos = {};
  for (const p of myPlayers) {
    const pos = primaryPosition(p);
    (myByPos[pos] ||= []).push(p);
  }
  const myPositionAverages = Object.fromEntries(Object.entries(myByPos).map(([pos, arr]) => [pos, arr.reduce((sum, p) => sum + p.score, 0) / arr.length]));
  const givePool = [...myPlayers]
    .sort((a, b) => {
      const aBench = a.selected_position === "BN" ? 1 : 0;
      const bBench = b.selected_position === "BN" ? 1 : 0;
      return bBench - aBench || b.score - a.score;
    })
    .slice(0, 10);
  const ideas = [];

  for (const opponent of opponentTeams) {
    const targets = [...(opponent.roster || [])].filter((p) => !["IR", "IL", "IL+"].includes(p.selected_position));
    for (const target of targets) {
      const targetPos = primaryPosition(target);
      const positionAvg = myPositionAverages[targetPos] || 0;
      const fillsWeakness = target.score > positionAvg + 2;
      if (!fillsWeakness) continue;

      const matches = givePool
        .filter((give) => primaryPosition(give) !== targetPos)
        .map((give) => ({ give, gap: Math.abs(give.score - target.score) }))
        .filter((x) => x.gap <= (sport === "nfl" ? 14 : 10))
        .sort((a, b) => a.gap - b.gap);
      if (!matches.length) continue;
      const give = matches[0].give;
      const projectedDelta = Number((target.score - give.score).toFixed(2));
      ideas.push({
        give: { name: give.name, player_key: give.player_key, position: give.display_position, team: give.editorial_team_abbr, score: give.score },
        get: { name: target.name, player_key: target.player_key, position: target.display_position, team: target.editorial_team_abbr, score: target.score },
        opponentTeam: { name: opponent.name, team_key: opponent.team_key },
        fairnessGap: Number(Math.abs(target.score - give.score).toFixed(2)),
        projectedDelta,
        reason: `${target.name} strengthens your ${targetPos} group while ${give.name} is a comparable-value piece from another position.`,
        sources: ["Yahoo Fantasy league rosters", "FantasyNerds consensus rankings & projections"]
      });
    }
  }

  return ideas.sort((a, b) => {
    const aScore = a.projectedDelta * 2 - a.fairnessGap;
    const bScore = b.projectedDelta * 2 - b.fairnessGap;
    return bScore - aScore;
  }).slice(0, 10);
}

async function getBasketballExternalData() {
  if (!FANTASYNERDS_API_KEY) return { projections: [], rater: [], injuries: [], lineups: [], news: [], schedule: [] };
  const today = new Date().toISOString().slice(0, 10);
  const calls = await Promise.allSettled([
    fantasyNerdsGet("nba", "draft-projections"),
    fantasyNerdsGet("nba", "player-rater"),
    fantasyNerdsGet("nba", "injuries"),
    fantasyNerdsGet("nba", "lineups", { date: today }),
    fantasyNerdsGet("nba", "news"),
    fantasyNerdsGet("nba", "schedule")
  ]);
  const u = (i) => (calls[i].status === "fulfilled" ? unwrapArray(calls[i].value) : []);
  return { projections: u(0), rater: u(1), injuries: u(2), lineups: u(3), news: u(4), schedule: u(5) };
}

async function getFootballExternalData(scoringFormat = "std", teamCount = 12) {
  if (!FANTASYNERDS_API_KEY) {
    return { weeklyRankings: [], weeklyProjections: [], ros: [], draftRankings: [], draftProjections: [], adp: [], injuries: [], news: [], schedule: [], byes: [], addDrops: [] };
  }
  const weeklyFormat = scoringFormat === "superflex" ? "ppr" : scoringFormat;
  const draftFormat = scoringFormat;
  const calls = await Promise.allSettled([
    fantasyNerdsGet("nfl", "weekly-rankings", { format: weeklyFormat }),
    fantasyNerdsGet("nfl", "weekly-projections"),
    fantasyNerdsGet("nfl", "ros"),
    fantasyNerdsGet("nfl", "draft-rankings", { format: draftFormat }),
    fantasyNerdsGet("nfl", "draft-projections"),
    fantasyNerdsGet("nfl", "adp", { format: draftFormat, teams: teamCount || 12 }),
    fantasyNerdsGet("nfl", "injuries"),
    fantasyNerdsGet("nfl", "news"),
    fantasyNerdsGet("nfl", "schedule"),
    fantasyNerdsGet("nfl", "byes"),
    fantasyNerdsGet("nfl", "add-drops")
  ]);
  const u = (i) => (calls[i].status === "fulfilled" ? unwrapArray(calls[i].value) : []);
  return {
    weeklyRankings: u(0), weeklyProjections: u(1), ros: u(2), draftRankings: u(3), draftProjections: u(4), adp: u(5),
    injuries: u(6), news: u(7), schedule: u(8), byes: u(9), addDrops: u(10)
  };
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.get("/auth/yahoo", (req, res) => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = crypto.randomBytes(24).toString("hex");
  req.session.yahooOAuthState = state;

  const authUrl =
    "https://api.login.yahoo.com/oauth2/request_auth" +
    `?client_id=${encodeURIComponent(YAHOO_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(YAHOO_REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent("openid")}` +
    `&nonce=${encodeURIComponent(nonce)}` +
    `&state=${encodeURIComponent(state)}` +
    `&language=en-us`;
  res.redirect(authUrl);
});

app.get("/auth/yahoo/callback", async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.status(400).send(`<h1>Yahoo authorization failed</h1><pre>${xmlEscape(error)}</pre>`);
  if (!code) return res.status(400).send("<h1>Missing authorization code</h1>");
  if (!state || state !== req.session.yahooOAuthState) return res.status(400).send("<h1>Invalid OAuth state</h1>");

  try {
    const basicAuth = Buffer.from(`${YAHOO_CLIENT_ID}:${YAHOO_CLIENT_SECRET}`).toString("base64");
    const params = new URLSearchParams();
    params.append("grant_type", "authorization_code");
    params.append("redirect_uri", YAHOO_REDIRECT_URI);
    params.append("code", code);

    const tokenRes = await axios.post(YAHOO_TOKEN_URL, params.toString(), {
      headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" }
    });

    req.session.accessToken = tokenRes.data.access_token;
    req.session.refreshToken = tokenRes.data.refresh_token || null;
    req.session.tokenExpiresAt = Date.now() + Math.max(0, Number(tokenRes.data.expires_in || 3600) - 60) * 1000;
    delete req.session.yahooOAuthState;
    res.redirect("/");
  } catch (err) {
    res.status(500).send(`<h1>Yahoo token exchange failed</h1><pre>${xmlEscape(JSON.stringify(err.response?.data || { message: err.message }, null, 2))}</pre>`);
  }
});

app.get("/api/me", (req, res) => {
  res.json({ connected: !!req.session.accessToken, sports: Object.keys(SUPPORTED_SPORTS) });
});

app.get("/api/yahoo/teams", async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: "Not connected to Yahoo." });

  try {
    const sports = ["nfl", "nba"];
    const calls = await Promise.allSettled(
      sports.map((sport) =>
        yahooGet(req, `${YAHOO_FANTASY_BASE}/users;use_login=1/games;game_keys=${sport}/teams?format=json`)
      )
    );

    const teams = [];
    const warnings = [];
    calls.forEach((result, i) => {
      const sport = sports[i];
      if (result.status === "fulfilled") teams.push(...parseTeamsFromUserGames(result.value, sport));
      else warnings.push(`${sport.toUpperCase()}: ${result.reason?.response?.status || "request failed"}`);
    });

    res.json({ teams, warnings });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch teams", details: err.response?.data || err.message });
  }
});

app.get("/api/team-analysis", async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: "Not connected to Yahoo." });
  const { team_key, league_key, sport = "nba" } = req.query;
  if (!team_key || !league_key) return res.status(400).json({ error: "Missing team_key or league_key" });
  if (!SUPPORTED_SPORTS[sport]) return res.status(400).json({ error: `Unsupported sport: ${sport}` });

  try {
    const settingsRaw = await yahooGet(req, `${YAHOO_FANTASY_BASE}/league/${encodeURIComponent(league_key)}/settings?format=json`);
    const leagueSettings = parseLeagueSettings(settingsRaw, sport);
    const externalPromise = sport === "nfl"
      ? getFootballExternalData(leagueSettings.scoringFormat, leagueSettings.teamCount || 12)
      : getBasketballExternalData();

    const availableCalls = [0, 25, 50, 75].map((start) =>
      yahooGet(req, `${YAHOO_FANTASY_BASE}/league/${encodeURIComponent(league_key)}/players;status=A;start=${start};count=25?format=json`)
    );
    const [rosterRaw, external, ...availablePages] = await Promise.all([
      yahooGet(req, `${YAHOO_FANTASY_BASE}/team/${encodeURIComponent(team_key)}/roster/players?format=json`),
      externalPromise,
      ...availableCalls
    ]);

    const rosterNodes = rosterRaw?.fantasy_content?.team?.[1]?.roster?.["0"]?.players;
    const rosterPlayers = toArrayLikeObjectEntries(rosterNodes).map(parseYahooPlayer).filter(Boolean);
    const availablePlayers = availablePages.flatMap((availableRaw) => {
      const availableNodes = availableRaw?.fantasy_content?.league?.[1]?.players;
      return toArrayLikeObjectEntries(availableNodes).map(parseYahooPlayer).filter(Boolean);
    });

    const context = {
      external: sport === "nfl" ? buildFootballExternalMaps(external) : buildBasketballExternalMaps(external),
      overrides: expertOverrides()
    };

    const scoredRoster = rosterPlayers.map((p) =>
      sport === "nfl" ? scoreFootballPlayer(p, context) : scoreBasketballPlayer(p, context)
    );

    res.json({
      sport,
      leagueSettings,
      sources: [
        { name: "Yahoo Fantasy", role: "League settings, roster, availability and transactions" },
        { name: "FantasyNerds", role: sport === "nfl" ? "Expert consensus rankings, projections, injuries, ADP and trends" : "Projections, player rater, injuries, lineups and schedule" }
      ],
      roster: scoredRoster.sort((a, b) => b.score - a.score),
      lineupSuggestions: buildLineupSuggestions(scoredRoster, sport),
      tradeIdeas: buildTradeIdeas(scoredRoster, sport),
      draftSuggestions: buildDraftSuggestions(availablePlayers, scoredRoster, context, sport, leagueSettings),
      waivers: buildWaiverSuggestions(availablePlayers, scoredRoster, context, sport),
      externalDataStatus: sport === "nfl" ? {
        weeklyRankings: external.weeklyRankings.length,
        weeklyProjections: external.weeklyProjections.length,
        ros: external.ros.length,
        draftRankings: external.draftRankings.length,
        draftProjections: external.draftProjections.length,
        adp: external.adp.length,
        injuries: external.injuries.length,
        byes: external.byes.length,
        addDrops: external.addDrops.length
      } : undefined
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: "Failed to analyze team", details: err.response?.data || err.message });
  }
});

app.get("/api/trade-suggestions", async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: "Not connected to Yahoo." });
  const { team_key, league_key, sport = "nba" } = req.query;
  if (!team_key || !league_key || !SUPPORTED_SPORTS[sport]) return res.status(400).json({ error: "Missing or invalid team/league/sport" });

  try {
    const [settingsRaw, teamsRaw] = await Promise.all([
      yahooGet(req, `${YAHOO_FANTASY_BASE}/league/${encodeURIComponent(league_key)}/settings?format=json`),
      yahooGet(req, `${YAHOO_FANTASY_BASE}/league/${encodeURIComponent(league_key)}/teams?format=json`)
    ]);
    const leagueSettings = parseLeagueSettings(settingsRaw, sport);
    const teams = parseLeagueTeams(teamsRaw, sport);
    const external = sport === "nfl"
      ? await getFootballExternalData(leagueSettings.scoringFormat, leagueSettings.teamCount || teams.length || 12)
      : await getBasketballExternalData();
    const context = {
      external: sport === "nfl" ? buildFootballExternalMaps(external) : buildBasketballExternalMaps(external),
      overrides: expertOverrides()
    };

    const rosterResults = await Promise.allSettled(teams.map(async (team) => {
      const raw = await yahooGet(req, `${YAHOO_FANTASY_BASE}/team/${encodeURIComponent(team.team_key)}/roster/players?format=json`);
      const nodes = raw?.fantasy_content?.team?.[1]?.roster?.["0"]?.players;
      const players = toArrayLikeObjectEntries(nodes).map(parseYahooPlayer).filter(Boolean).map((p) =>
        sport === "nfl" ? scoreFootballPlayer(p, context) : scoreBasketballPlayer(p, context)
      );
      return { ...team, roster: players };
    }));

    const loaded = rosterResults.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const mine = loaded.find((t) => t.team_key === team_key);
    const opponents = loaded.filter((t) => t.team_key !== team_key);
    if (!mine) return res.status(404).json({ error: "Could not load your team roster for trade analysis." });

    res.json({
      suggestions: buildLeagueTradeSuggestions(mine.roster, opponents, sport),
      teamsScanned: opponents.length,
      sources: ["Yahoo Fantasy league rosters", "FantasyNerds consensus rankings & projections"]
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: "Failed to build trade suggestions", details: err.response?.data || err.message });
  }
});

app.post("/api/yahoo/add-drop", async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: "Not connected to Yahoo." });
  const { league_key, team_key, add_player_key, drop_player_key, faab_bid } = req.body;
  if (!league_key || !team_key || !add_player_key || !drop_player_key) return res.status(400).json({ error: "Missing required fields" });

  const xml = `<?xml version="1.0"?>
<fantasy_content><transaction><type>add/drop</type>${faab_bid ? `<faab_bid>${xmlEscape(faab_bid)}</faab_bid>` : ""}<players>
<player><player_key>${xmlEscape(add_player_key)}</player_key><transaction_data><type>add</type><destination_team_key>${xmlEscape(team_key)}</destination_team_key></transaction_data></player>
<player><player_key>${xmlEscape(drop_player_key)}</player_key><transaction_data><type>drop</type><source_team_key>${xmlEscape(team_key)}</source_team_key></transaction_data></player>
</players></transaction></fantasy_content>`;

  try {
    const out = await yahooRequest(req, {
      method: "POST",
      url: `${YAHOO_FANTASY_BASE}/league/${encodeURIComponent(league_key)}/transactions`,
      data: xml,
      headers: { "Content-Type": "application/xml" }
    });
    res.json({ ok: true, result: out.data });
  } catch (err) {
    res.status(500).json({ error: "Add/drop failed", details: err.response?.data || err.message });
  }
});

app.post("/api/yahoo/propose-trade", async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: "Not connected to Yahoo." });
  const { league_key, trader_team_key, tradee_team_key, give_player_keys, get_player_keys, note } = req.body;
  if (!league_key || !trader_team_key || !tradee_team_key || !Array.isArray(give_player_keys) || !Array.isArray(get_player_keys)) {
    return res.status(400).json({ error: "Missing required trade fields" });
  }

  const giveXml = give_player_keys.map((pk) => `<player><player_key>${xmlEscape(pk)}</player_key><transaction_data><type>pending_trade</type><source_team_key>${xmlEscape(trader_team_key)}</source_team_key><destination_team_key>${xmlEscape(tradee_team_key)}</destination_team_key></transaction_data></player>`).join("");
  const getXml = get_player_keys.map((pk) => `<player><player_key>${xmlEscape(pk)}</player_key><transaction_data><type>pending_trade</type><source_team_key>${xmlEscape(tradee_team_key)}</source_team_key><destination_team_key>${xmlEscape(trader_team_key)}</destination_team_key></transaction_data></player>`).join("");
  const xml = `<?xml version="1.0"?><fantasy_content><transaction><type>pending_trade</type><trader_team_key>${xmlEscape(trader_team_key)}</trader_team_key><tradee_team_key>${xmlEscape(tradee_team_key)}</tradee_team_key><trade_note>${xmlEscape(note || "Trade proposal from ProGM")}</trade_note><players>${giveXml}${getXml}</players></transaction></fantasy_content>`;

  try {
    const out = await yahooRequest(req, {
      method: "POST",
      url: `${YAHOO_FANTASY_BASE}/league/${encodeURIComponent(league_key)}/transactions`,
      data: xml,
      headers: { "Content-Type": "application/xml" }
    });
    res.json({ ok: true, result: out.data });
  } catch (err) {
    res.status(500).json({ error: "Trade proposal failed", details: err.response?.data || err.message });
  }
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
