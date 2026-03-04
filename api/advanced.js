export default async function handler(_req, res) {
  try {
    // ── 1. USG% from stats.nba.com (wrapped — may fail from cloud IPs) ───────
    const nbaHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.nba.com/',
      'Origin': 'https://www.nba.com',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'x-nba-stats-origin': 'stats',
      'x-nba-stats-token': 'true',
    };

    let playerMap = {};
    try {
      const nbaUrl = `https://stats.nba.com/stats/leaguedashplayerstats?LastNGames=0&MeasureType=Advanced&Month=0&OpponentTeamID=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlusMinus=N&Rank=N&Season=2025-26&SeasonType=Regular%20Season&LeagueID=00`;
      const nbaRes = await fetch(nbaUrl, { headers: nbaHeaders });
      if (nbaRes.ok) {
        const nbaData = await nbaRes.json();
        const head    = nbaData.resultSets[0].headers;
        const idxName = head.indexOf("PLAYER_NAME");
        const idxTeam = head.indexOf("TEAM_ABBREVIATION");
        const idxUsg  = head.indexOf("USG_PCT");
        for (const row of nbaData.resultSets[0].rowSet) {
          playerMap[row[idxName]] = { team: row[idxTeam], usage: row[idxUsg] };
        }
      }
    } catch (e) {
      console.warn("NBA stats API (USG%) failed — expected from cloud IPs:", e.message);
    }

    // ── 2. L10 averages via ESPN boxscores (reliable from Vercel) ────────────
    // Fetch the last 21 days of scoreboards in parallel (individual dates confirmed to work)
    const today = new Date();
    const fmt   = d => d.toISOString().split('T')[0].replace(/-/g, '');

    const dateStrs = Array.from({ length: 21 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (i + 1));
      return fmt(d);
    });

    const scoreboards = await Promise.all(
      dateStrs.map(ds =>
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ds}`)
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

    // Fetch up to 15 boxscores in parallel
    const boxscores = await Promise.all(
      recentIds.map(id =>
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`)
          .then(r => r.json())
          .catch(() => null)
      )
    );

    // Aggregate per-game stats per player (order = most-recent first)
    const playerGames = {};
    for (const bs of boxscores) {
      if (!bs?.boxscore?.players) continue;
      for (const teamBlock of bs.boxscore.players) {
        for (const statsGroup of (teamBlock.statistics || [])) {
          const keys     = statsGroup.keys || [];
          const ptIdx    = keys.indexOf("PTS");
          const rebIdx   = keys.indexOf("REB");
          const astIdx   = keys.indexOf("AST");
          const threeIdx = keys.indexOf("3PT");

          for (const ath of (statsGroup.athletes || [])) {
            const name  = ath.athlete?.displayName;
            const stats = ath.stats || [];
            if (!name || !stats.length) continue;
            const pts = parseFloat(stats[ptIdx]);
            if (isNaN(pts)) continue; // DNP / no data
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

    // Compute averages over last 10 games per player
    const last10 = {};
    for (const [name, games] of Object.entries(playerGames)) {
      const g   = games.slice(0, 10);
      const avg = key => g.reduce((s, x) => s + (x[key] || 0), 0) / g.length;
      last10[name] = { PTS: avg("PTS"), REB: avg("REB"), AST: avg("AST"), "3PM": avg("3PM") };
    }

    // ── 3. B2B detection from yesterday's ESPN scoreboard ────────────────────
    const d = new Date();
    d.setHours(d.getHours() - 10); // approximate US timezone offset
    d.setDate(d.getDate() - 1);
    const yyyymmdd = d.toISOString().split('T')[0].replace(/-/g, '');

    const espnUrl  = `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yyyymmdd}`;
    const espnRes  = await fetch(espnUrl);
    const espnData = await espnRes.json();

    const espnToNba = { "GS": "GSW", "UTAH": "UTA", "NO": "NOP", "SA": "SAS", "NY": "NYK", "WSH": "WAS", "BKN": "BKN" };
    const b2bTeams  = new Set();
    if (espnData.events) {
      for (const event of espnData.events) {
        event.competitions[0].competitors.forEach(c => {
          const abbr = c.team.abbreviation.toUpperCase();
          b2bTeams.add(espnToNba[abbr] || abbr);
        });
      }
    }

    res.status(200).json({ players: playerMap, b2bTeams: Array.from(b2bTeams), last10 });
  } catch (error) {
    console.error("Advanced Stats proxy error:", error);
    res.status(500).json({ error: error.message });
  }
}
