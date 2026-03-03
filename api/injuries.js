export default async function handler(req, res) {
  try {
    const response = await fetch("https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/injuries");
    if (!response.ok) {
      throw new Error(`ESPN API returned ${response.status}`);
    }
    
    const data = await response.json();
    const injuriesMap = {};

    // Parse ESPN's format into a simple Map: { "Player Name": "Status" }
    // ESPN format: { injuries: [ { team: {...}, injuries: [ { status: "Out", athlete: { displayName: "Player" } } ] } ] }
    if (data && data.injuries && Array.isArray(data.injuries)) {
      for (const teamTeamItem of data.injuries) {
        if (teamTeamItem.injuries && Array.isArray(teamTeamItem.injuries)) {
          for (const injury of teamTeamItem.injuries) {
            const player = injury.athlete?.displayName;
            const status = injury.status || "Injured";
            if (player) {
              injuriesMap[player] = status;
            }
          }
        }
      }
    }

    res.status(200).json(injuriesMap);
  } catch (error) {
    console.error("Injury fetch error:", error);
    res.status(500).json({ error: "Failed to fetch injury data" });
  }
}
