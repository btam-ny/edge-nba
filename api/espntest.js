export default async function handler(_req, res) {
  try {
    // Step 1: fetch yesterday's scoreboard
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const dateStr = d.toISOString().split('T')[0].replace(/-/g, '');

    const sbRes  = await fetch(
      `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`
    );
    const sbData = await sbRes.json();

    const events = sbData.events || [];
    const completed = events.filter(e => e.status?.type?.completed);

    if (!completed.length) {
      return res.status(200).json({
        message: `No completed games on ${dateStr}`,
        allEvents: events.map(e => ({ id: e.id, name: e.name, status: e.status?.type }))
      });
    }

    // Step 2: fetch the first completed game's boxscore
    const eventId = completed[0].id;
    const bsRes   = await fetch(
      `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`
    );
    const bsData  = await bsRes.json();

    const boxscorePlayers = bsData.boxscore?.players || [];

    // Show the raw keys and first player's stats for each team
    const teamSummaries = boxscorePlayers.map(teamBlock => {
      const statsGroup = teamBlock.statistics?.[0];
      const keys       = statsGroup?.keys || [];
      const firstAth   = statsGroup?.athletes?.[0];

      return {
        teamAbbr:    teamBlock.team?.abbreviation,
        teamName:    teamBlock.team?.displayName,
        statKeys:    keys,
        samplePlayer: firstAth ? {
          name:  firstAth.athlete?.displayName,
          stats: firstAth.stats,
        } : null,
        playerCount: statsGroup?.athletes?.length,
      };
    });

    res.status(200).json({
      date:          dateStr,
      eventId,
      gameName:      completed[0].name,
      teamSummaries,
      // also return top-level keys of bsData so we can see what's available
      topLevelKeys:  Object.keys(bsData),
      boxscoreKeys:  bsData.boxscore ? Object.keys(bsData.boxscore) : [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}
