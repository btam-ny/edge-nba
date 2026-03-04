export default async function handler(req, res) {
  try {
    const nbaHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': 'https://www.nba.com/',
      'Origin': 'https://stats.nba.com',
      'Accept': 'application/json, text/plain, */*',
    };

    const nbaUrl = `https://stats.nba.com/stats/leaguedashplayerstats?LastNGames=10&MeasureType=Base&Month=0&OpponentTeamID=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlusMinus=N&Rank=N&Season=2025-26&SeasonType=Regular%20Season&LeagueID=00`;

    const nbaRes = await fetch(nbaUrl, { headers: nbaHeaders });
    if (!nbaRes.ok) throw new Error("NBA API returned " + nbaRes.status);
    const nbaData = await nbaRes.json();

    const head = nbaData.resultSets[0].headers;
    const idxName = head.indexOf("PLAYER_NAME");
    const idxPts  = head.indexOf("PTS");
    const idxReb  = head.indexOf("REB");
    const idxAst  = head.indexOf("AST");
    const idxFg3m = head.indexOf("FG3M");

    const playerMap = {};
    for (const row of nbaData.resultSets[0].rowSet) {
      playerMap[row[idxName]] = {
        PTS:  row[idxPts],
        REB:  row[idxReb],
        AST:  row[idxAst],
        "3PM": row[idxFg3m],
      };
    }

    res.status(200).json(playerMap);
  } catch (error) {
    console.error("Last 10 proxy error:", error);
    res.status(500).json({ error: error.message });
  }
}
