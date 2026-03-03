export default async function handler(req, res) {
  // Use the 2025-26 season based on current date (March 2026)
  const url = `https://stats.nba.com/stats/leaguedashteamstats?MeasureType=Advanced&PerMode=PerGame&PlusMinus=N&PaceAdjust=N&Rank=N&LeagueID=00&Season=2025-26&SeasonType=Regular%20Season&PORound=0&LastNGames=10`;

  try {
    const nbaRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://www.nba.com/',
        'Origin': 'https://stats.nba.com',
        'Accept': 'application/json, text/plain, */*',
      }
    });

    if (!nbaRes.ok) throw new Error("NBA API returned " + nbaRes.status);
    
    const data = await nbaRes.json();
    
    // Parse the NBA API response format (it's tabular: headers array + rowset matrix)
    const headers = data.resultSets[0].headers;
    const teamNameIdx = headers.indexOf("TEAM_NAME");
    const defRtgIdx = headers.indexOf("DEF_RATING");
    const paceIdx = headers.indexOf("PACE");

    const teamDef = {};
    data.resultSets[0].rowSet.forEach(row => {
      teamDef[row[teamNameIdx]] = {
        defRtg: row[defRtgIdx],
        pace: row[paceIdx]
      };
    });

    res.status(200).json(teamDef);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
