const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "7f15289082msh2b80f8151be1e74p16fba4jsnff9ea5c99f8d";
const HOST = "tank01-fantasy-stats.p.rapidapi.com";

const tank01 = (endpoint, params = {}) => {
  const url = new URL(`https://${HOST}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return fetch(url.toString(), {
    headers: {
      "X-RapidAPI-Key":  RAPIDAPI_KEY,
      "X-RapidAPI-Host": HOST,
    },
  }).then(r => r.json());
};

const espnFetch = (url, ms = 5000) => {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).then(r => r.json()).finally(() => clearTimeout(id));
};

export default async function handler(_req, res) {
  try {
    const today     = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const fmtTank01 = d => {
      const y   = d.getFullYear();
      const m   = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}${m}${day}`;
    };
    const fmtEspn = d => d.toISOString().split("T")[0].replace(/-/g, "");

    // ── 1 & 2: Tank01 — teams (rosters + season avgs) + yesterday's schedule ─
    // ── 3: ESPN — last 12 days of scoreboards for box score IDs ──────────────
    const espnDateStrs = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (i + 1));
      return fmtEspn(d);
    });

    const [teamsData, ydayGames, ...scoreboards] = await Promise.all([
      tank01("getNBATeams", { rosters: "true", statsToGet: "averages" }),
      tank01("getNBAGamesForDate", { gameDate: fmtTank01(yesterday) }),
      ...espnDateStrs.map(ds =>
        espnFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ds}`)
          .catch(() => null)
      ),
    ]);

    // ── 4. Build player map + teamDef from Tank01 data ────────────────────────
    const players = {};  // { "LeBron James": { team, usage, playerID } }
    const teamDef = {};  // { "LAL": { defRtg, pace } }

    for (const team of (teamsData.body || [])) {
      const abbr = team.teamAbv;
      const oppg = parseFloat(team.oppg) || 112;
      const ppg  = parseFloat(team.ppg)  || 112;
      // Pace proxy: avg possessions per game ≈ (ppg + oppg) / 2.2
      teamDef[abbr] = { defRtg: oppg, pace: (ppg + oppg) / 2.2 };

      for (const [, info] of Object.entries(team.Roster || {})) {
        const name = info.longName;
        if (!name) continue;
        players[name] = { team: abbr, usage: 0, playerID: info.playerID };
      }
    }

    // ── 5. B2B: teams that played yesterday ───────────────────────────────────
    const b2bTeams = new Set();
    for (const game of (ydayGames.body || [])) {
      if (game.away) b2bTeams.add(game.away);
      if (game.home) b2bTeams.add(game.home);
    }

    // ── 6. ESPN box scores → true L10 per player ─────────────────────────────
    const eventIds = [];
    for (const sb of scoreboards) {
      for (const event of (sb?.events || [])) {
        if (event.status?.type?.completed) eventIds.push(event.id);
      }
    }
    const recentIds = eventIds.slice(0, 12);

    const boxscores = await Promise.all(
      recentIds.map(id =>
        espnFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`)
          .catch(() => null)
      )
    );

    const playerGames = {}; // { name: [{ PTS, REB, AST, "3PM" }, ...] }
    for (const bs of boxscores) {
      if (!bs?.boxscore?.players) continue;
      for (const teamBlock of bs.boxscore.players) {
        for (const statsGroup of (teamBlock.statistics || [])) {
          const keys     = statsGroup.keys || statsGroup.statKeys || [];
          const ptIdx    = keys.indexOf("PTS");
          const rebIdx   = keys.indexOf("REB");
          const astIdx   = keys.indexOf("AST");
          const threeIdx = keys.indexOf("3PT");

          for (const ath of (statsGroup.athletes || [])) {
            const name  = ath.athlete?.displayName;
            const stats = ath.stats || [];
            if (!name || !stats.length) continue;
            const pts = parseFloat(stats[ptIdx]);
            if (isNaN(pts)) continue;

            if (!playerGames[name]) playerGames[name] = [];
            playerGames[name].push({
              PTS:   pts,
              REB:   parseFloat(stats[rebIdx]) || 0,
              AST:   parseFloat(stats[astIdx]) || 0,
              "3PM": parseInt((stats[threeIdx] || "0-0").split("-")[0]) || 0,
            });
          }
        }
      }
    }

    const last10 = {};
    for (const [name, games] of Object.entries(playerGames)) {
      const g   = games.slice(0, 10);
      const avg = key => g.reduce((s, x) => s + (x[key] || 0), 0) / g.length;
      last10[name] = { PTS: avg("PTS"), REB: avg("REB"), AST: avg("AST"), "3PM": avg("3PM") };
    }

    res.status(200).json({ players, b2bTeams: [...b2bTeams], teamDef, last10 });
  } catch (error) {
    console.error("Advanced Stats error:", error);
    res.status(500).json({ error: error.message });
  }
}
