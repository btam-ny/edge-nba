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

// Normalize player names for fuzzy matching (strip punctuation, lowercase)
const normName = s => s?.toLowerCase().replace(/[^a-z ]/g, "").trim() || "";

export default async function handler(req, res) {
  try {
    const playerNames = req.query?.players
      ? req.query.players.split(",").map(p => p.trim()).filter(Boolean)
      : [];

    const today     = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const fmtDate = d => {
      const y   = d.getFullYear();
      const m   = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}${m}${day}`;
    };

    // ── 1 & 2: Parallel — all teams (rosters + stats) + yesterday's schedule ─
    const [teamsData, ydayGames] = await Promise.all([
      tank01("getNBATeams", { rosters: "true", statsToGet: "averages", teamStats: "true" }),
      tank01("getNBAGamesForDate", { gameDate: fmtDate(yesterday) }),
    ]);

    // ── 3. Build player map + teamDef from team data ──────────────────────────
    const players    = {};  // { "LeBron James": { team, usage, playerID } }
    const playerIDMap = {}; // { normName: playerID } for fuzzy matching
    const teamDef    = {};  // { "LAL": { defRtg, pace } }

    for (const team of (teamsData.body || [])) {
      const abbr = team.teamAbv;
      const oppg = parseFloat(team.oppg) || 112;
      const ppg  = parseFloat(team.ppg)  || 112;

      // Pace proxy: avg possessions per game ≈ (ppg + oppg) / 2.2
      // (assumes ~1.1 pts per possession, both teams)
      const pace = (ppg + oppg) / 2.2;

      teamDef[abbr] = { defRtg: oppg, pace };

      for (const [playerID, info] of Object.entries(team.Roster || {})) {
        const name = info.longName;
        if (!name) continue;

        // usage from averages — Tank01 returns as a percentage (e.g. 28.5), normalize to 0-1
        const usageRaw = parseFloat(info.stats?.usgRate ?? info.stats?.usage ?? 0);
        const usage    = usageRaw > 1 ? usageRaw / 100 : usageRaw;

        players[name] = { team: abbr, usage, playerID, _raw: info };
        playerIDMap[normName(name)] = { playerID, canonicalName: name };
      }
    }

    // ── 4. B2B: teams that played yesterday ───────────────────────────────────
    const b2bTeams = new Set();
    for (const game of (ydayGames.body || [])) {
      if (game.away) b2bTeams.add(game.away);
      if (game.home) b2bTeams.add(game.home);
    }

    // ── 5. L10 game logs for requested players ────────────────────────────────
    const last10 = {};

    if (playerNames.length > 0) {
      await Promise.all(
        playerNames.map(async name => {
          // Exact match → fall back to normalized match
          const exactEntry   = players[name];
          const fuzzyEntry   = playerIDMap[normName(name)];
          const playerID     = exactEntry?.playerID ?? fuzzyEntry?.playerID;
          const canonicalName = exactEntry ? name : fuzzyEntry?.canonicalName;

          if (!playerID || !canonicalName) return;

          try {
            const logData = await tank01("getNBAPlayerGameLog", {
              playerID,
              numberOfGames: "10",
            });

            const games = (logData.body?.playerGameLog || []).slice(0, 10);
            if (!games.length) return;

            const avg = key =>
              games.reduce((s, g) => s + (parseFloat(g[key]) || 0), 0) / games.length;

            last10[name] = {
              PTS:  avg("pts"),
              REB:  avg("reb"),
              AST:  avg("ast"),
              "3PM": avg("tptfgm"),
            };
          } catch {
            // Skip — individual player failure shouldn't break the whole response
          }
        })
      );
    }

    res.status(200).json({
      players,
      b2bTeams: [...b2bTeams],
      teamDef,
      last10,
    });
  } catch (error) {
    console.error("Advanced Stats error:", error);
    res.status(500).json({ error: error.message });
  }
}
