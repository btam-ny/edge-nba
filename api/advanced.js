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

export default async function handler(_req, res) {
  try {
    const today     = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const fmtDate = d => {
      const y   = d.getFullYear();
      const m   = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}${m}${day}`;
    };

    // ── 1 & 2: Parallel — all teams (rosters + season avgs) + yesterday's schedule
    const [teamsData, ydayGames] = await Promise.all([
      tank01("getNBATeams", { rosters: "true", statsToGet: "averages" }),
      tank01("getNBAGamesForDate", { gameDate: fmtDate(yesterday) }),
    ]);

    // ── 3. Build player map + last10 (season avgs) + teamDef ─────────────────
    const players = {};  // { "LeBron James": { team, usage, playerID } }
    const last10  = {};  // { "LeBron James": { PTS, REB, AST, "3PM" } }
    const teamDef = {};  // { "LAL": { defRtg, pace } }

    for (const team of (teamsData.body || [])) {
      const abbr = team.teamAbv;
      const oppg = parseFloat(team.oppg) || 112;
      const ppg  = parseFloat(team.ppg)  || 112;

      // Pace proxy: avg possessions per game ≈ (ppg + oppg) / 2.2
      const pace = (ppg + oppg) / 2.2;
      teamDef[abbr] = { defRtg: oppg, pace };

      for (const [, info] of Object.entries(team.Roster || {})) {
        const name = info.longName;
        if (!name) continue;

        players[name] = { team: abbr, usage: 0, playerID: info.playerID };

        // Use season averages as the L10 proxy (Tank01 has no game log endpoint)
        const s = info.stats;
        if (s && parseFloat(s.gamesPlayed) > 0) {
          last10[name] = {
            PTS:   parseFloat(s.pts)     || 0,
            REB:   parseFloat(s.reb)     || 0,
            AST:   parseFloat(s.ast)     || 0,
            "3PM": parseFloat(s.tptfgm)  || 0,
          };
        }
      }
    }

    // ── 4. B2B: teams that played yesterday ───────────────────────────────────
    const b2bTeams = new Set();
    for (const game of (ydayGames.body || [])) {
      if (game.away) b2bTeams.add(game.away);
      if (game.home) b2bTeams.add(game.home);
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
