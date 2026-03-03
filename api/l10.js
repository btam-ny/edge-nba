export default async function handler(req, res) {
  // NBA requires some specific headers or it blocks the request
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Referer': 'https://www.nba.com/',
    'Origin': 'https://stats.nba.com',
    'Accept': 'application/json, text/plain, */*',
  };

  const url = `https://stats.nba.com/stats/leaguedashplayerstats?LastNGames=10&MeasureType=Base&Month=0&OpponentTeamID=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlusMinus=N&Rank=N&Season=2025-26&SeasonType=Regular%20Season&LeagueID=00`;

  try {
    const apiRes = await fetch(url, { headers });
    if (!apiRes.ok) throw new Error("NBA API returned " + apiRes.status);
    
    const data = await apiRes.json();
    
    const head = data.resultSets[0].headers;
    const idxName = head.indexOf("PLAYER_NAME");
    const idxPts = head.indexOf("PTS");
    const idxReb = head.indexOf("REB");
    const idxAst = head.indexOf("AST");
    const idx3pm = head.indexOf("FG3M");

    const playerStats = {};
    for (const row of data.resultSets[0].rowSet) {
      playerStats[row[idxName]] = {
        PTS: row[idxPts],
        REB: row[idxReb],
        AST: row[idxAst],
        "3PM": row[idx3pm],
      };
    }

    res.status(200).json(playerStats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
