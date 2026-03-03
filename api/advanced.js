export default async function handler(req, res) {
  try {
    // 1. Fetch Advanced Player Stats for Usage and Team mappings
    const nbaHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': 'https://www.nba.com/',
      'Origin': 'https://stats.nba.com',
      'Accept': 'application/json, text/plain, */*',
    };
    
    // We fetch the season-long advanced stats to get reliable USG%
    const nbaUrl = `https://stats.nba.com/stats/leaguedashplayerstats?LastNGames=0&MeasureType=Advanced&Month=0&OpponentTeamID=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlusMinus=N&Rank=N&Season=2025-26&SeasonType=Regular%20Season&LeagueID=00`;
    
    const nbaRes = await fetch(nbaUrl, { headers: nbaHeaders });
    if (!nbaRes.ok) throw new Error("NBA API returned " + nbaRes.status);
    const nbaData = await nbaRes.json();

    const head = nbaData.resultSets[0].headers;
    const idxName = head.indexOf("PLAYER_NAME");
    const idxTeam = head.indexOf("TEAM_ABBREVIATION");
    const idxUsg = head.indexOf("USG_PCT");

    const playerMap = {};
    for (const row of nbaData.resultSets[0].rowSet) {
      playerMap[row[idxName]] = {
        team: row[idxTeam],
        usage: row[idxUsg]
      };
    }

    // 2. Fetch yesterday's scoreboard to determine B2B (Back-To-Back) teams
    // Use server's current date (we want yesterday relative to US time)
    // To be safe, just subtract 24 hours
    const d = new Date();
    d.setHours(d.getHours() - 10); // Offset to approximate US timezone
    d.setDate(d.getDate() - 1);
    const yyyymmdd = d.toISOString().split('T')[0].replace(/-/g, '');

    const espnUrl = `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yyyymmdd}`;
    const espnRes = await fetch(espnUrl);
    const espnData = await espnRes.json();

    // ESPN uses slightly different abbreviations sometimes, we map them to NBA standard
    const espnToNba = {
      "GS": "GSW", "UTAH": "UTA", "NO": "NOP", 
      "SA": "SAS", "NY": "NYK", "WSH": "WAS", "BKN": "BKN"
    };

    const b2bTeams = new Set();
    if (espnData.events) {
      for (const event of espnData.events) {
        event.competitions[0].competitors.forEach(c => {
          let abbr = c.team.abbreviation.toUpperCase();
          b2bTeams.add(espnToNba[abbr] || abbr);
        });
      }
    }

    res.status(200).json({ players: playerMap, b2bTeams: Array.from(b2bTeams) });
  } catch (error) {
    console.error("Advanced Stats proxy error:", error);
    res.status(500).json({ error: error.message });
  }
}
