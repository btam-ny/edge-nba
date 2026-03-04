export default async function handler(_req, res) {
  try {
    // ESPN abbreviation → NBA standard
    const espnToNba = { "GS": "GSW", "UTAH": "UTA", "NO": "NOP", "SA": "SAS", "NY": "NYK", "WSH": "WAS", "BKN": "BKN" };
    const normAbbr  = a => espnToNba[a?.toUpperCase()] || a?.toUpperCase() || "";

    // ── 1. Fetch last 21 days of scoreboards in parallel ─────────────────────
    const today = new Date();
    const fmt   = d => d.toISOString().split('T')[0].replace(/-/g, '');

    const dateStrs = Array.from({ length: 21 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (i + 1));
      return fmt(d);
    });

    const scoreboards = await Promise.all(
      dateStrs.map(ds =>
        fetch(`https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ds}`)
          .then(r => r.json())
          .catch(() => null)
      )
    );

    // Collect completed event IDs, most recent first (scoreboards[0] = yesterday)
    const eventIds = [];
    for (const sb of scoreboards) {
      for (const event of (sb?.events || [])) {
        if (event.status?.type?.completed) eventIds.push(event.id);
      }
    }
    const recentIds = eventIds.slice(0, 15);

    // ── 2. Fetch up to 15 boxscores in parallel ───────────────────────────────
    const boxscores = await Promise.all(
      recentIds.map(id =>
        fetch(`https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`)
          .then(r => r.json())
          .catch(() => null)
      )
    );

    // ── 3. Parse player L10 stats + team def/pace from the same boxscores ────
    const playerGames = {}; // { playerName: [{ PTS, REB, AST, 3PM }, ...] }
    const teamGameLog = {}; // { abbr: [{ poss, ptsAllowed }, ...] }

    for (const bs of boxscores) {
      if (!bs?.boxscore?.players) continue;

      const gameTeams = []; // collect both teams to pair them for def computation

      for (const teamBlock of bs.boxscore.players) {
        const abbr = normAbbr(teamBlock.team?.abbreviation);
        let teamPts = 0, teamFga = 0, teamFta = 0, teamOreb = 0, teamTov = 0;

        for (const statsGroup of (teamBlock.statistics || [])) {
          const keys     = statsGroup.keys || [];
          const ptIdx    = keys.indexOf("PTS");
          const rebIdx   = keys.indexOf("REB");
          const astIdx   = keys.indexOf("AST");
          const threeIdx = keys.indexOf("3PT");
          const fgIdx    = keys.indexOf("FG");
          const ftIdx    = keys.indexOf("FT");
          const orebIdx  = keys.indexOf("OREB");
          const tovIdx   = keys.indexOf("TO");

          for (const ath of (statsGroup.athletes || [])) {
            const name  = ath.athlete?.displayName;
            const stats = ath.stats || [];
            if (!stats.length) continue;

            // ── Player L10 ──
            if (name) {
              const pts = parseFloat(stats[ptIdx]);
              if (!isNaN(pts)) {
                if (!playerGames[name]) playerGames[name] = [];
                playerGames[name].push({
                  PTS:   pts,
                  REB:   parseFloat(stats[rebIdx]) || 0,
                  AST:   parseFloat(stats[astIdx]) || 0,
                  "3PM": parseInt((stats[threeIdx] || "0-0").split("-")[0]) || 0,
                });
              }
            }

            // ── Team totals for def/pace ──
            teamPts  += parseFloat(stats[ptIdx]) || 0;
            teamFga  += parseInt((stats[fgIdx]  || "0-0").split("-")[1]) || 0;
            teamFta  += parseInt((stats[ftIdx]  || "0-0").split("-")[1]) || 0;
            teamOreb += parseFloat(stats[orebIdx]) || 0;
            teamTov  += parseFloat(stats[tovIdx])  || 0;
          }
        }

        const poss = teamFga + 0.44 * teamFta - teamOreb + teamTov;
        gameTeams.push({ abbr, pts: teamPts, poss });
      }

      // Pair both teams to compute def rating (points allowed / own possessions)
      if (gameTeams.length === 2) {
        const [a, b] = gameTeams;
        if (a.abbr) {
          if (!teamGameLog[a.abbr]) teamGameLog[a.abbr] = [];
          teamGameLog[a.abbr].push({ poss: a.poss, ptsAllowed: b.pts });
        }
        if (b.abbr) {
          if (!teamGameLog[b.abbr]) teamGameLog[b.abbr] = [];
          teamGameLog[b.abbr].push({ poss: b.poss, ptsAllowed: a.pts });
        }
      }
    }

    // ── Player L10 averages (last 10 games) ───────────────────────────────────
    const last10 = {};
    for (const [name, games] of Object.entries(playerGames)) {
      const g   = games.slice(0, 10);
      const avg = key => g.reduce((s, x) => s + (x[key] || 0), 0) / g.length;
      last10[name] = { PTS: avg("PTS"), REB: avg("REB"), AST: avg("AST"), "3PM": avg("3PM") };
    }

    // ── Team def rating + pace (last 10 games) ────────────────────────────────
    // defRtg  = opponent points per 100 possessions
    // pace    = average possessions per game (proxy for NBA pace metric)
    const teamDef = {};
    for (const [abbr, games] of Object.entries(teamGameLog)) {
      const g          = games.slice(0, 10);
      const totalPoss  = g.reduce((s, x) => s + x.poss, 0);
      const totalPtsA  = g.reduce((s, x) => s + x.ptsAllowed, 0);
      teamDef[abbr] = {
        defRtg: totalPoss > 0 ? (totalPtsA / totalPoss) * 100 : 110,
        pace:   totalPoss / g.length,
      };
    }

    // ── 4. B2B detection from yesterday's ESPN scoreboard ────────────────────
    const d = new Date();
    d.setHours(d.getHours() - 10); // approximate US timezone offset
    d.setDate(d.getDate() - 1);
    const yyyymmdd = d.toISOString().split('T')[0].replace(/-/g, '');

    const espnRes  = await fetch(
      `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yyyymmdd}`
    );
    const espnData = await espnRes.json();

    const b2bTeams = new Set();
    if (espnData.events) {
      for (const event of espnData.events) {
        event.competitions[0].competitors.forEach(c => {
          b2bTeams.add(normAbbr(c.team.abbreviation));
        });
      }
    }

    res.status(200).json({
      players:  {},           // USG% omitted — stats.nba.com blocked from cloud IPs
      b2bTeams: Array.from(b2bTeams),
      last10,
      teamDef,
    });
  } catch (error) {
    console.error("Advanced Stats proxy error:", error);
    res.status(500).json({ error: error.message });
  }
}
