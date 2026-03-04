import { useState, useMemo, useRef, useEffect } from "react";

// ─── CONFIG ────────────────────────────────────────────────────────────────
const ODDS_API_KEY  = "ad9c98df0ad0b20b460ed1b2fc63e04d";
const ODDS_BASE     = "https://api.the-odds-api.com/v4";
const SPORT         = "basketball_nba";
const REGIONS       = "us";
const ODDS_FORMAT   = "american";
// Batch all markets per event to minimize calls (1 call per game not per market)
const PROP_MARKETS  = "player_points,player_rebounds,player_assists,player_threes";
const BOOKMAKERS    = "draftkings,fanduel"; // limit to 2 books to keep response small

// ─── TEAM DEFENSIVE PROFILES (from live NBA API) ───────────────────────────
const TEAM_DEF_STATIC = {
  DET: { defRtg: 101.5, pace: 98.2  }, CLE: { defRtg: 104.6, pace: 96.8  },
  MIL: { defRtg: 115.1, pace: 91.4  }, CHI: { defRtg: 113.7, pace: 97.1  },
  IND: { defRtg: 118.5, pace: 102.3 }, ORL: { defRtg: 107.2, pace: 94.5  },
  MIA: { defRtg: 109.8, pace: 95.6  }, ATL: { defRtg: 116.2, pace: 99.4  },
  CHA: { defRtg: 117.4, pace: 100.1 }, WAS: { defRtg: 120.1, pace: 103.2 },
  BOS: { defRtg: 104.6, pace: 96.2  }, NYK: { defRtg: 108.3, pace: 95.8  },
  TOR: { defRtg: 112.5, pace: 97.3  }, PHI: { defRtg: 118.5, pace: 93.7  },
  BKN: { defRtg: 121.3, pace: 98.8  }, LAL: { defRtg: 103.4, pace: 104.7 },
  PHX: { defRtg: 110.2, pace: 98.1  }, GSW: { defRtg: 112.3, pace: 99.5  },
  LAC: { defRtg: 101.5, pace: 94.1  }, SAC: { defRtg: 122.3, pace: 100.6 },
  OKC: { defRtg: 103.2, pace: 96.4  }, MIN: { defRtg: 105.8, pace: 95.2  },
  DEN: { defRtg: 123.0, pace: 96.4  }, POR: { defRtg: 116.8, pace: 101.2 },
  UTA: { defRtg: 132.8, pace: 98.4  }, SAS: { defRtg: 106.4, pace: 97.8  },
  HOU: { defRtg: 114.4, pace: 104.3 }, MEM: { defRtg: 115.9, pace: 99.7  },
  DAL: { defRtg: 119.0, pace: 98.5  }, NOP: { defRtg: 124.6, pace: 101.8 },
};

// Map full team names from Odds API → abbreviations
const TEAM_NAME_MAP = {
  "Detroit Pistons": "DET", "Cleveland Cavaliers": "CLE", "Milwaukee Bucks": "MIL",
  "Chicago Bulls": "CHI", "Indiana Pacers": "IND", "Orlando Magic": "ORL",
  "Miami Heat": "MIA", "Atlanta Hawks": "ATL", "Charlotte Hornets": "CHA",
  "Washington Wizards": "WAS", "Boston Celtics": "BOS", "New York Knicks": "NYK",
  "Toronto Raptors": "TOR", "Philadelphia 76ers": "PHI", "Brooklyn Nets": "BKN",
  "Los Angeles Lakers": "LAL", "Phoenix Suns": "PHX", "Golden State Warriors": "GSW",
  "LA Clippers": "LAC", "Sacramento Kings": "SAC", "Oklahoma City Thunder": "OKC",
  "Minnesota Timberwolves": "MIN", "Denver Nuggets": "DEN", "Portland Trail Blazers": "POR",
  "Utah Jazz": "UTA", "San Antonio Spurs": "SAS", "Houston Rockets": "HOU",
  "Memphis Grizzlies": "MEM", "Dallas Mavericks": "DAL", "New Orleans Pelicans": "NOP",
};

const MARKET_LABEL = {
  player_points: "PTS", player_rebounds: "REB",
  player_assists: "AST", player_threes: "3PM",
};

// ─── MATH ──────────────────────────────────────────────────────────────────
const LEAGUE_AVG_DEF_RTG = 113.2;
const LEAGUE_AVG_PACE    = 98.4;

function normCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422820 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z > 0 ? 1 - p : p;
}

function getDefGrade(defRtg) {
  if (defRtg < 105) return "ELITE";
  if (defRtg < 109) return "GOOD";
  if (defRtg < 114) return "AVG";
  if (defRtg < 119) return "POOR";
  return "BAD";
}

const DEF_GRADE_COLOR = {
  ELITE: "#a3ff57", GOOD: "#57ffa3", AVG: "#00e5ff", POOR: "#ffb347", BAD: "#ff3d71", "N/A": "#4a6070"
};

// ─── EV CALCULATION from real odds ─────────────────────────────────────────
// Instead of generating a line, we use the REAL bookmaker line and odds,
// then compare against our adjusted model probability.
function americanToProb(american) {
  if (american < 0) return Math.abs(american) / (Math.abs(american) + 100);
  return 100 / (american + 100);
}

function calcEV(modelProb, bookOdds, oppOdds) {
  // Remove vig by normalizing both sides so they sum to 1
  const rawProb  = americanToProb(bookOdds);
  const rawOpp   = americanToProb(oppOdds);
  const trueProb = rawProb / (rawProb + rawOpp);
  // Probability edge: how much better our model is vs the vig-removed price.
  // Dividing by modelProb inflates small edges — raw difference is more honest.
  return modelProb - trueProb;
}

// ─── PARSE ODDS API RESPONSE into prop rows ────────────────────────────────
function parseEventProps(event) {
  const homeTeam = event.home_team;
  const awayTeam = event.away_team;
  const homeAbbr = TEAM_NAME_MAP[homeTeam];
  const awayAbbr = TEAM_NAME_MAP[awayTeam];
  const rows = [];

  for (const bookmaker of (event.bookmakers || [])) {
    for (const market of (bookmaker.markets || [])) {
      const marketLabel = MARKET_LABEL[market.key];
      if (!marketLabel) continue;

      // Group outcomes by player name
      const byPlayer = {};
      for (const outcome of market.outcomes) {
        const name = outcome.description || outcome.name;
        if (!byPlayer[name]) byPlayer[name] = {};
        byPlayer[name][outcome.name] = { price: outcome.price, line: outcome.point };
      }

      for (const [playerName, sides] of Object.entries(byPlayer)) {
        const over  = sides["Over"];
        const under = sides["Under"];
        if (!over || !under) continue;

        const line = over.line;

        // Determine which team player is on (we'll refine with stats data)
        // For now mark as unknown, adjustments applied by team context
        rows.push({
          player:    playerName,
          market:    marketLabel,
          marketKey: market.key,
          line,
          bookmaker: bookmaker.title,
          overOdds:  over.price,
          underOdds: under.price,
          homeTeam,
          awayTeam,
          homeAbbr,
          awayAbbr,
          eventId:   event.id,
          commenceTime: event.commence_time,
        });
      }
    }
  }
  return rows;
}

// ─── APPLY MODEL ADJUSTMENTS + COMPUTE EV ─────────────────────────────────
function applyAdjustmentsAndEV(props, teamDef, advancedData, injuries) {
  // Compute league averages from loaded data so adjustments are always centered,
  // regardless of whether static or live defense data is in use.
  const defVals = Object.values(teamDef);
  const leagueAvgDefRtg = defVals.length
    ? defVals.reduce((s, t) => s + t.defRtg, 0) / defVals.length
    : LEAGUE_AVG_DEF_RTG;
  const validPaces = defVals.filter(t => t.pace > 0);
  const leagueAvgPace = validPaces.length
    ? validPaces.reduce((s, t) => s + t.pace, 0) / validPaces.length
    : LEAGUE_AVG_PACE;

  // Pre-calculate Missing Star Usage bump per team
  const bumpPerTeam = {};
  for (const [playerName, stats] of Object.entries(advancedData.players)) {
    if (injuries[playerName] === "Out" && stats.usage > 0.25) {
      bumpPerTeam[stats.team] = true;
    }
  }

  return props.map(prop => {
    const { player, line, overOdds, underOdds, homeAbbr, awayAbbr, market } = prop;

    // Advanced Data links player to exactly 1 team.
    // Note: players is always {} (stats.nba.com blocked from cloud IPs),
    // so playerTeam is always null. Guessing awayAbbr caused every player
    // to use the home team's defense as oppDef — inflating EV for entire games
    // whenever the home team had a bad defense.
    const playerAdv = advancedData.players[player] || { team: null, usage: 0 };
    const playerTeam = playerAdv.team; // null when stats unavailable

    const isHome  = playerTeam ? (playerTeam === homeAbbr) : null;
    const oppAbbr = isHome === true ? awayAbbr : isHome === false ? homeAbbr : null;

    // When team unknown, fall back to league-average defense → defMult stays 1.0
    const oppDef  = (oppAbbr && teamDef[oppAbbr])
      ? teamDef[oppAbbr]
      : { defRtg: leagueAvgDefRtg, pace: leagueAvgPace };
    const homeDef = teamDef[homeAbbr] || { defRtg: leagueAvgDefRtg, pace: leagueAvgPace };
    const awayDef = teamDef[awayAbbr] || { defRtg: leagueAvgDefRtg, pace: leagueAvgPace };

    // 1. Defensive adjustment (= 1.0 when team unknown, oppDef = league avg)
    const defDiff  = oppDef.defRtg - leagueAvgDefRtg;
    const defScale = market === "3PM" ? 0.015 : market === "REB" ? 0.008 : market === "AST" ? 0.008 : 0.012;
    let   defMult  = 1 + (defDiff / 5) * defScale;

    // 2. Pace adjustment (game-level — average both teams' pace)
    const gamePace = (homeDef.pace + awayDef.pace) / 2;
    let   paceMult = leagueAvgPace > 0
      ? 1 + ((gamePace - leagueAvgPace) / leagueAvgPace) * 0.4
      : 1.0;

    // 3. Home/Away Role Player Split — only when team is known
    let homeRoadMult = 1.0;
    if (isHome !== null && market === "3PM" && line < 18.5) {
      homeRoadMult = isHome ? 1.05 : 0.95;
    }

    // 4. Back-to-Back Rest Penalty
    const isB2B = playerTeam
      ? advancedData.b2bTeams.includes(playerTeam)
      : advancedData.b2bTeams.includes(homeAbbr) || advancedData.b2bTeams.includes(awayAbbr);
    let b2bMult = 1.0;
    if (isB2B) {
      if (market === "PTS" || market === "AST") b2bMult = 0.97;
      if (market === "3PM") b2bMult = 0.95;
      if (market === "REB") b2bMult = 1.02; // more missed shots = more rebounds available
    }

    // 5. Usage Bump (Star Teammate is OUT)
    let usageMult = 1.0;
    // Don't apply usage bump to the star themselves who is OUT
    if (bumpPerTeam[playerTeam] && injuries[player] !== "Out") {
      usageMult = 1.08; 
    }

    // Combine all Multipliers
    let finalMult = defMult * paceMult * homeRoadMult * b2bMult * usageMult;
    finalMult = Math.max(0.80, Math.min(1.20, finalMult)); // hard cap multipliers

    // Adjusted expected value (book line as baseline)
    const adjLine = (line * finalMult);

    // Std dev based on the book line (not adjLine) so the spread stays neutral
    // and only the center shifts — avoids compounding the under bias
    const stdPcts     = { PTS: 0.28, REB: 0.32, AST: 0.35, "3PM": 0.45 };
    const adjStd      = line * (stdPcts[market] || 0.30);

    // Model probability for over/under
    const zOver       = (line + 0.5 - adjLine) / adjStd;
    const zUnder      = (line - 0.5 - adjLine) / adjStd;
    const modelOver   = 1 - normCDF(zOver);
    const modelUnder  = normCDF(zUnder);

    const evOver      = calcEV(modelOver,  overOdds,  underOdds);
    const evUnder     = calcEV(modelUnder, underOdds, overOdds);

    const defGrade    = getDefGrade(oppDef.defRtg);

    return {
      ...prop,
      adjLine:    +adjLine.toFixed(2),
      adjStd:     +adjStd.toFixed(2),
      gamePace:   +gamePace.toFixed(1),
      defGrade,
      defRtg:     oppDef.defRtg,
      finalMult:  +finalMult.toFixed(3),
      isB2B,
      usageBump:  usageMult > 1.0,
      isHome: isHome ?? false,
      modelOver:  +modelOver.toFixed(4),
      modelUnder: +modelUnder.toFixed(4),
      evOver:     +evOver.toFixed(4),
      evUnder:    +evUnder.toFixed(4),
    };
  });
}


// ─── STYLES ────────────────────────────────────────────────────────────────
const C = {
  bg: "#080c10", surface: "#0e1419", surface2: "#141c24", border: "#1e2d3d",
  accent: "#00e5ff", positive: "#a3ff57", negative: "#ff3d71", neutral: "#00e5ff", muted: "#4a6070", text: "#e8edf2",
};
const gridBg = `repeating-linear-gradient(rgba(0,229,255,0.03) 0,rgba(0,229,255,0.03) 1px,transparent 1px,transparent 40px),repeating-linear-gradient(90deg,rgba(0,229,255,0.03) 0,rgba(0,229,255,0.03) 1px,transparent 1px,transparent 40px)`;
const STAT_FILTERS = ["ALL", "PTS", "REB", "AST", "3PM"];
const BOOK_FILTERS = ["ALL", "DraftKings", "FanDuel"];
const mono = { fontFamily: "monospace" };

export default function App() {
  const [events,      setEvents]      = useState(() => { try { return JSON.parse(localStorage.getItem('edge_events')) || []; } catch { return []; } });
  const [props,       setProps]       = useState(() => { try { return JSON.parse(localStorage.getItem('edge_props')) || []; } catch { return []; } });
  const [loading,     setLoading]     = useState(false);
  const [loadingMsg,  setLoadingMsg]  = useState("");
  const [error,       setError]       = useState(null);
  const [lastUpdated, setLastUpdated] = useState(() => localStorage.getItem('edge_updated') || "");
  const [statFilter,  setStatFilter]  = useState("ALL");
  const [dirFilter,   setDirFilter]   = useState("ALL");
  const [bookFilter,  setBookFilter]  = useState("ALL");
  const [evMin,       setEvMin]       = useState(-20);
  const [showAdj,     setShowAdj]     = useState(false);
  const cache = useRef({});
  const [teamDef,       setTeamDef]       = useState(TEAM_DEF_STATIC);
  const [teamDefSource, setTeamDefSource] = useState("STATIC");
  const [injuries,      setInjuries]      = useState({});
  const [advancedData,  setAdvancedData]  = useState({ players: {}, b2bTeams: [] });
  const [last10Data,    setLast10Data]    = useState({});
  const [activeTab,       setActiveTab]       = useState("props");
  const [trackerPlays,    setTrackerPlays]    = useState(() => { try { return JSON.parse(localStorage.getItem('edge_tracker')) || []; } catch { return []; } });
  const [checkingResults, setCheckingResults] = useState(false);

  useEffect(() => {
    // Save to local storage whenever our core data updates
    try {
      if (events.length > 0) localStorage.setItem("edge_events", JSON.stringify(events));
      if (props.length > 0) localStorage.setItem("edge_props", JSON.stringify(props));
      if (lastUpdated) localStorage.setItem("edge_updated", lastUpdated);
    } catch (err) {
      console.warn("Storage quota exceeded", err);
    }
  }, [events, props, lastUpdated]);

  useEffect(() => {
    // 1. Fetch Injuries
    fetch("https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/injuries")
      .then(res => res.json())
      .then(data => {
        const injuryMap = {};
        if (data?.injuries) {
          for (const teamItem of data.injuries) {
            if (teamItem.injuries) {
              for (const inj of teamItem.injuries) {
                const player = inj.athlete?.displayName;
                const status = inj.status || "Injured";
                if (player) injuryMap[player] = status;
              }
            }
          }
        }
        setInjuries(injuryMap);
      })
      .catch(err => console.error("Could not fetch injuries", err));


    // 4. Fetch Advanced Stats, B2B, Last 10 Games, and Team Def/Pace
    fetch("/api/advanced")
      .then(res => res.json())
      .then(data => {
        if (data?.players) setAdvancedData(data);
        if (data?.last10)  setLast10Data(data.last10);
        if (data?.teamDef && Object.keys(data.teamDef).length > 20) {
          setTeamDef(data.teamDef);
          setTeamDefSource("LIVE");
        }
      })
      .catch(err => console.error("Could not fetch advanced data", err));
  }, []);

  // ── API helpers ──────────────────────────────────────────────────────────
  async function oddsApiFetch(url) {
    const res  = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ── FETCH PIPELINE ───────────────────────────────────────────────────────
  async function fetchAll() {
    setLoading(true);
    setError(null);
    setProps([]);

    try {
      // ── Step 1: Get NBA events (1 call) ─────────────────────────────────
      setLoadingMsg("Fetching today's NBA games… (1 call)");
      const eventsData = await oddsApiFetch(
        `${ODDS_BASE}/sports/${SPORT}/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`
      );
      setEvents(eventsData);

      if (!eventsData.length) {
        setError("No NBA games found today. Try again closer to game time.");
        setLoading(false);
        return;
      }

      // ── Step 2: Fetch props per event (1 call each) ──────────────────────
      const allProps = [];
      let callNum = 2;

      for (const event of eventsData) {
        const cacheKey = `${event.id}_${PROP_MARKETS}`;

        setLoadingMsg(
          `Fetching props: ${event.away_team} @ ${event.home_team}… (call ${callNum} of ~${eventsData.length + 1})`
        );

        let eventOdds;
        if (cache.current[cacheKey]) {
          eventOdds = cache.current[cacheKey];
        } else {
          eventOdds = await oddsApiFetch(
            `${ODDS_BASE}/sports/${SPORT}/events/${event.id}/odds` +
            `?apiKey=${ODDS_API_KEY}&regions=${REGIONS}&markets=${PROP_MARKETS}` +
            `&oddsFormat=${ODDS_FORMAT}&bookmakers=${BOOKMAKERS}`
          );
          cache.current[cacheKey] = eventOdds;
        }

        const parsed = parseEventProps(eventOdds);
        allProps.push(...parsed);
        callNum++;

        // Small delay to respect rate limits
        await new Promise(r => setTimeout(r, 700));
      }

      // ── Step 3: Apply adjustments + EV ──────────────────────────────────
      setLoadingMsg("Applying advanced adjustments (Def, Pace, B2B, H/A, Usage)…");
      const withEV = applyAdjustmentsAndEV(allProps, teamDef, advancedData, injuries);
      setProps(withEV);
      setLastUpdated("UPDATED " + new Date().toLocaleTimeString());

      // Auto-save top 10 EV plays for today (once per day)
      const today = new Date().toISOString().split("T")[0];
      setTrackerPlays(prev => {
        if (prev.some(p => p.date === today)) return prev;
        const top10 = withEV
          .flatMap(p => [
            { ...p, direction: "Over",  ev: p.evOver,  bookOdds: p.overOdds  },
            { ...p, direction: "Under", ev: p.evUnder, bookOdds: p.underOdds },
          ])
          .sort((a, b) => b.ev - a.ev)
          .slice(0, 10)
          .map(p => ({
            id:        `${today}_${p.player}_${p.market}_${p.direction}`,
            date:      today,
            player:    p.player,
            market:    p.market,
            direction: p.direction,
            line:      p.line,
            ev:        p.ev,
            bookOdds:  p.bookOdds,
            bookmaker: p.bookmaker,
            awayAbbr:  p.awayAbbr,
            homeAbbr:  p.homeAbbr,
            result:    null,
            actual:    null,
          }));
        const updated = [...prev, ...top10];
        try { localStorage.setItem('edge_tracker', JSON.stringify(updated)); } catch {}
        return updated;
      });

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMsg("");
    }
  }

  // ── CHECK RESULTS via ESPN boxscores ─────────────────────────────────────
  async function checkResults() {
    setCheckingResults(true);
    try {
      const today   = new Date().toISOString().split("T")[0];
      const pending = trackerPlays.filter(p => p.result === null && p.date < today);
      if (!pending.length) return;

      // { "YYYY-MM-DD_PlayerName": { PTS, REB, AST, "3PM" } }
      const statsMap = {};
      const dates    = [...new Set(pending.map(p => p.date))];

      for (const date of dates) {
        const dateStr = date.replace(/-/g, "");
        const sbRes   = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`
        );
        const sbData = await sbRes.json();

        for (const event of (sbData.events || [])) {
          if (!event.status?.type?.completed) continue;
          const bsRes  = await fetch(
            `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${event.id}`
          );
          const bsData = await bsRes.json();

          for (const teamBlock of (bsData.boxscore?.players || [])) {
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
                statsMap[`${date}_${name}`] = {
                  PTS:   parseFloat(stats[ptIdx])  || 0,
                  REB:   parseFloat(stats[rebIdx]) || 0,
                  AST:   parseFloat(stats[astIdx]) || 0,
                  "3PM": parseInt((stats[threeIdx] || "0-0").split("-")[0]) || 0,
                };
              }
            }
          }
        }
      }

      const updated = trackerPlays.map(play => {
        if (play.result !== null || play.date >= today) return play;
        const playerStats = statsMap[`${play.date}_${play.player}`];
        if (!playerStats) return play;
        const actual = playerStats[play.market];
        if (actual === undefined) return play;
        const hit = play.direction === "Over" ? actual > play.line : actual < play.line;
        return { ...play, result: hit ? "HIT" : "MISS", actual };
      });

      setTrackerPlays(updated);
      try { localStorage.setItem('edge_tracker', JSON.stringify(updated)); } catch {}
    } catch (err) {
      console.error("checkResults error", err);
    } finally {
      setCheckingResults(false);
    }
  }

  // ── FILTERED + SORTED TABLE DATA ─────────────────────────────────────────
  const tableRows = useMemo(() => {
    const expanded = props.flatMap(p => {
      const l10Avg = last10Data[p.player]?.[p.market] ?? null;
      return [
        { ...p, direction: "Over",  ev: p.evOver,  modelProb: p.modelOver,  bookOdds: p.overOdds,  l10Avg },
        { ...p, direction: "Under", ev: p.evUnder, modelProb: p.modelUnder, bookOdds: p.underOdds, l10Avg },
      ];
    });

    return expanded
      .filter(r => statFilter === "ALL" || r.market === statFilter)
      .filter(r => dirFilter  === "ALL" || r.direction === dirFilter)
        .filter(r => bookFilter === "ALL" || r.bookmaker.toLowerCase() === bookFilter.toLowerCase())
        .filter(r => r.ev * 100 >= evMin)
      .sort((a, b) => b.ev - a.ev);
}, [props, statFilter, dirFilter, bookFilter, evMin, last10Data]);

  const posCount = tableRows.filter(r => r.ev > 0).length;
  const bestEv   = tableRows.length ? ([...tableRows].sort((a,b) => b.ev - a.ev)[0].ev * 100).toFixed(1) : "—";
  const avgEv    = tableRows.length ? (tableRows.reduce((s,r) => s + r.ev, 0) / tableRows.length * 100).toFixed(1) : "—";

  const loaded = props.length > 0;

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'DM Sans',sans-serif", fontSize: 14 }}>
      <div style={{ position: "fixed", inset: 0, backgroundImage: gridBg, pointerEvents: "none", zIndex: 0 }} />
      <style>{`
        .table-container {
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
        }
        .app-header { padding: 18px 28px; }
        .app-body { padding: 22px 28px; }
        .config-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
        .config-panel { padding: 18px 22px; }
        
        @media (max-width: 768px) {
          .app-header { padding: 12px 8px; flex-direction: column; align-items: flex-start !important; gap: 12px; }
          .app-body { padding: 12px 6px; }
          .config-panel { padding: 12px 10px; }
          .config-grid { grid-template-columns: 1fr; gap: 6px; margin-bottom: 10px; }
          .mobile-pad { padding: 8px 4px !important; }
          .mobile-head { padding: 10px 4px !important; font-size: 8px !important; letter-spacing: 0px !important; }
          .player-name-text { max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px !important; display: block; }
          .injury-badge { font-size: 7px !important; padding: 1px 3px !important; margin-left: 4px !important; }
          .book-name { font-size: 9px !important; max-width: 50px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .stat-badge { padding: 2px 4px !important; font-size: 8px !important; }
          .text-sm-mobile { font-size: 10px !important; }
          .ev-bar { display: none !important; }
          .ev-text { font-size: 11px !important; }
          table { min-width: 100% !important; }
          td { white-space: nowrap; }
        }
      `}</style>
      <div style={{ position: "relative", zIndex: 1 }}>

        {/* HEADER */}
        <div className="app-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.border}`, background: "rgba(8,12,16,0.94)", backdropFilter: "blur(10px)", position: "sticky", top: 0, zIndex: 100 }}>
          <div>
            <div style={{ ...mono, fontSize: 34, fontWeight: 900, letterSpacing: 6, color: C.accent, textShadow: `0 0 28px rgba(0,229,255,0.4)`, lineHeight: 1 }}>Degen Tool by Tam</div>
            <div style={{ ...mono, fontSize: 10, letterSpacing: 3, color: C.text, opacity: 0.3 }}>NBA PROP FINDER · LIVE ODDS</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 24, ...mono, fontSize: 11 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, color: C.muted, fontSize: 10 }}>
              <span><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", marginRight: 6, background: loaded ? C.positive : C.muted, boxShadow: loaded ? `0 0 8px ${C.positive}` : "none" }} />{loading ? loadingMsg.split("…")[0] : loaded ? "LIVE DATA" : "READY"}</span>
              {lastUpdated && <span style={{ opacity: 0.5 }}>{lastUpdated}</span>}
              <span style={{ color: teamDefSource === "LIVE" ? C.positive : C.muted }}>DEF DATA: {teamDefSource}</span>
            </div>
          </div>
        </div>

        <div className="app-body">

          {/* TABS */}
          <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, marginBottom: 18 }}>
            {[["props", "PROPS"], ["tracker", "TRACKER"]].map(([key, label]) => (
              <button key={key} onClick={() => setActiveTab(key)} style={{ background: "transparent", border: "none", borderBottom: `2px solid ${activeTab === key ? C.accent : "transparent"}`, color: activeTab === key ? C.accent : C.muted, ...mono, fontSize: 11, letterSpacing: 3, padding: "8px 22px 10px", cursor: "pointer", marginBottom: -1 }}>
                {label}
                {key === "tracker" && trackerPlays.length > 0 && (
                  <span style={{ marginLeft: 6, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 2, padding: "1px 5px", fontSize: 9 }}>{trackerPlays.length}</span>
                )}
              </button>
            ))}
          </div>

          {activeTab === "props" && <>

          {/* CONFIG PANEL */}
          <div className="config-panel" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 2, marginBottom: 18, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg,${C.accent},transparent)` }} />
            <div className="config-grid">
              {[
                { icon: "📊", label: "DEF · PACE", value: "L10 Def proxy & aggregate game pace baseline" },
                { icon: "🏠", label: "HOME SPLIT", value: "3PM volume & role-player momentum variance" },
                { icon: "🏥", label: "USG BUMP", value: "Stars ruled OUT boost teammate projections" },
                { icon: "🪫", label: "B2B REST", value: "Back-to-back rest penalties minus rebounding" },
                { icon: "🛡", label: "DVP PROXY", value: "Overall def variance by stat category" },
                { icon: "📡", label: "LIVE FEED", value: "The Odds API, real-time ESPN injury reports" },
              ].map(item => (
                <div key={item.label} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 2, padding: "10px 12px" }}>
                  <div style={{ ...mono, fontSize: 9, letterSpacing: 2, color: C.accent, marginBottom: 3 }}>{item.icon} {item.label}</div>
                  <div style={{ ...mono, fontSize: 10, color: C.muted, lineHeight: 1.6 }}>{item.value}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <div style={{ ...mono, fontSize: 10, color: C.muted, flex: 1 }}>
                {loaded ? `${events.length} games · ${props.length} raw props · cached this session` : `Ready`}
              </div>
              <button onClick={() => setShowAdj(a => !a)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, ...mono, fontSize: 10, letterSpacing: 2, padding: "6px 12px", borderRadius: 2, cursor: "pointer" }}>
                {showAdj ? "HIDE ADJ" : "SHOW ADJ"}
              </button>
              <button onClick={fetchAll} disabled={loading} style={{ background: loading ? C.muted : C.accent, color: C.bg, border: "none", borderRadius: 2, padding: "10px 26px", ...mono, fontSize: 15, fontWeight: 900, letterSpacing: 3, cursor: loading ? "not-allowed" : "pointer", height: 40, whiteSpace: "nowrap" }}>
                {loading ? "LOADING…" : loaded ? "REFRESH" : "FETCH LIVE"}
              </button>
            </div>

            {/* Loading progress */}
            {loading && (
              <div style={{ marginTop: 10, ...mono, fontSize: 10, color: C.accent, letterSpacing: 1 }}>
                <span style={{ marginRight: 8, animation: "pulse 1s infinite", display: "inline-block" }}>▶</span>
                {loadingMsg}
                <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
              </div>
            )}
          </div>

          {/* ERROR */}
          {error && (
            <div style={{ background: "rgba(255,61,113,0.08)", border: `1px solid rgba(255,61,113,0.3)`, borderRadius: 2, padding: "14px 18px", marginBottom: 16, ...mono, fontSize: 12, color: C.negative }}>
              ✗ ERROR: {error}
            </div>
          )}

          {/* SUMMARY */}
          {loaded && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1, background: C.border, border: `1px solid ${C.border}`, borderRadius: 2, marginBottom: 16, overflow: "hidden" }}>
              {[
                { label: "TOTAL PROPS", value: tableRows.length,                    color: C.neutral  },
                { label: "POSITIVE EV",  value: posCount,                            color: C.positive },
                { label: "BEST EDGE",    value: bestEv !== "—" ? bestEv + "%" : "—", color: C.accent   },
                { label: "AVG EV%",      value: avgEv  !== "—" ? avgEv  + "%" : "—", color: C.muted    },
              ].map(cell => (
                <div key={cell.label} style={{ background: C.surface, padding: "12px 16px" }}>
                  <div style={{ ...mono, fontSize: 9, letterSpacing: 2, color: C.muted, marginBottom: 3 }}>{cell.label}</div>
                  <div style={{ ...mono, fontSize: 24, fontWeight: 900, letterSpacing: 2, color: cell.color, lineHeight: 1 }}>{cell.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* FILTERS */}
          {loaded && (
            <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 2, padding: "5px 10px" }}>
                <span style={{ ...mono, fontSize: 9, letterSpacing: 2, color: C.muted }}>STAT</span>
                {STAT_FILTERS.map(s => (
                  <button key={s} onClick={() => setStatFilter(s)} style={{ ...mono, fontSize: 9, letterSpacing: 1, padding: "3px 8px", borderRadius: 2, border: `1px solid ${statFilter===s ? C.accent : C.border}`, background: statFilter===s ? C.accent : "transparent", color: statFilter===s ? C.bg : C.muted, cursor: "pointer" }}>{s}</button>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 2, padding: "5px 10px" }}>
                <span style={{ ...mono, fontSize: 9, letterSpacing: 2, color: C.muted }}>DIR</span>
                {["ALL","Over","Under"].map(d => (
                  <button key={d} onClick={() => setDirFilter(d)} style={{ ...mono, fontSize: 9, letterSpacing: 1, padding: "3px 8px", borderRadius: 2, border: `1px solid ${dirFilter===d ? C.accent : C.border}`, background: dirFilter===d ? C.accent : "transparent", color: dirFilter===d ? C.bg : C.muted, cursor: "pointer" }}>{d.toUpperCase()}</button>
                ))}
              </div>                <div style={{ display: "flex", alignItems: "center", gap: 6, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 2, padding: "5px 10px" }}>
                  <span style={{ ...mono, fontSize: 9, letterSpacing: 2, color: C.muted }}>BOOK</span>
                  {BOOK_FILTERS.map(b => (
                    <button key={b} onClick={() => setBookFilter(b)} style={{ ...mono, fontSize: 9, letterSpacing: 1, padding: "3px 8px", borderRadius: 2, border: `1px solid ${bookFilter===b ? C.accent : C.border}`, background: bookFilter===b ? C.accent : "transparent", color: bookFilter===b ? C.bg : C.muted, cursor: "pointer" }}>{b.toUpperCase()}</button>
                  ))}
                </div>              <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 2, padding: "5px 10px" }}>
                <span style={{ ...mono, fontSize: 9, letterSpacing: 2, color: C.muted }}>MIN EV%</span>
                <input type="range" min={-30} max={30} value={evMin} onChange={e => setEvMin(+e.target.value)} style={{ width: 80, accentColor: C.accent }} />
                <span style={{ ...mono, fontSize: 10, color: C.accent, minWidth: 32 }}>{evMin > 0 ? "+" : ""}{evMin}%</span>
              </div>
              <span style={{ marginLeft: "auto", ...mono, fontSize: 10, color: C.muted }}>{tableRows.length} PROPS SHOWN</span>
            </div>
          )}

          {/* TABLE */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 2, overflow: "hidden" }}>
            {!loaded && !loading && !error && (
              <div style={{ padding: "80px 40px", textAlign: "center" }}>
                <div style={{ ...mono, fontSize: 56, color: C.border, lineHeight: 1 }}>◈</div>
                <div style={{ ...mono, fontSize: 18, letterSpacing: 4, color: C.muted, marginTop: 14 }}>AWAITING DATA</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 8, maxWidth: 440, margin: "8px auto 0" }}>
                  Click FETCH LIVE to pull real prop lines from DraftKings, FanDuel & BetMGM with defense, pace, and home/away adjustments applied.
                </div>
                <div style={{ ...mono, fontSize: 10, color: C.muted, marginTop: 14, opacity: 0.5 }}>
                  ~{10 + 1} API calls per session · results cached for this tab
                </div>
              </div>
            )}
            {loading && (
              <div style={{ padding: "80px 40px", textAlign: "center" }}>
                <div style={{ width: 30, height: 30, border: `2px solid ${C.border}`, borderTopColor: C.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite", margin: "0 auto" }} />
                <div style={{ ...mono, fontSize: 16, letterSpacing: 4, color: C.muted, marginTop: 18 }}>{loadingMsg || "LOADING…"}</div>
                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              </div>
            )}
            {loaded && !loading && tableRows.length === 0 && (
              <div style={{ padding: "60px", textAlign: "center" }}>
                <div style={{ ...mono, fontSize: 16, letterSpacing: 4, color: C.muted }}>NO RESULTS</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>Lower the min EV threshold or clear filters.</div>
              </div>
            )}
            {loaded && !loading && tableRows.length > 0 && (() => {
              const maxEV = Math.max(...tableRows.map(x => Math.abs(x.ev)));
              const cols = [
                { key: "player",    label: "PLAYER" },
                { key: "market",    label: "STAT" },
                { key: "direction", label: "DIR" },
                { key: "ev",        label: "EV%" },
                { key: "line",      label: "LINE" },
                { key: "l10Avg",    label: "L10" },
                { key: "adjLine",   label: "PROJ" },
                { key: "bookOdds",  label: "ODDS" },
                { key: "bookmaker", label: "BOOK" },
                { key: "homeTeam",  label: "MATCHUP" },
                ...(showAdj ? [
                  { key: "defGrade", label: "DEF" },
                  { key: "gamePace", label: "PACE" },
                ] : [
                  { key: "defGrade", label: "DEF" },
                ]),
                { key: "modelProb", label: "MODEL%" },
              ];

              return (
                <div className="table-container">
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: C.surface2, borderBottom: `1px solid ${C.border}` }}>
                        {cols.map(col => (
                          <th key={col.key} className="mobile-head" style={{ padding: "10px 12px", textAlign: "left", ...mono, fontSize: 9, letterSpacing: 2, whiteSpace: "nowrap", color: col.key === "ev" ? C.accent : C.muted }}>
                            {col.label}{col.key === "ev" && " ↓"}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map((r, i) => {
                        const evPct   = (r.ev * 100).toFixed(1);
                        const evColor = r.ev > 0.05 ? C.positive : r.ev > 0 ? C.neutral : C.negative;
                        const barW    = Math.min(50, Math.abs(r.ev) / (maxEV || 1) * 50);
                        const price   = r.bookOdds > 0 ? `+${r.bookOdds}` : `${r.bookOdds}`;
                        

                        return (
                          <tr key={i} style={{ borderBottom: `1px solid rgba(30,45,61,0.5)`, background: i%2===0 ? "transparent" : "rgba(20,28,36,0.3)" }}>
                            <td className="mobile-pad" style={{ padding: "10px 12px" }}>
                              <div style={{ display: "flex", alignItems: "center", fontWeight: 500, fontSize: 13 }}>
                                <span className="player-name-text">{r.player}</span>
                                {injuries[r.player] && (
                                  <span className="injury-badge" title={`Injury Status: ${injuries[r.player]}`} style={{ marginLeft: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", background: injuries[r.player] === "Out" ? "rgba(255,61,113,0.15)" : "rgba(255,179,71,0.15)", color: injuries[r.player] === "Out" ? C.negative : "#ffb347", border: `1px solid ${injuries[r.player] === "Out" ? "rgba(255,61,113,0.3)" : "rgba(255,179,71,0.3)"}`, borderRadius: 2, padding: "1px 4px", fontSize: 9, fontWeight: 700, flexShrink: 0, ...mono }}>
                                    {injuries[r.player] === "Out" ? "OUT" : injuries[r.player] === "Day-To-Day" ? "DTD" : injuries[r.player].toUpperCase()}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="mobile-pad" style={{ padding: "10px 12px" }}>
                              <span className="stat-badge" style={{ background: C.surface2, border: `1px solid ${C.border}`, padding: "2px 7px", borderRadius: 2, ...mono, fontSize: 9, color: C.neutral }}>{r.market}</span>
                            </td>
                            <td className="mobile-pad" style={{ padding: "10px 12px" }}>
                              <span className="stat-badge" style={{ padding: "2px 7px", borderRadius: 2, ...mono, fontSize: 9, fontWeight: 600, background: r.direction==="Over" ? "rgba(163,255,87,0.1)" : "rgba(255,61,113,0.1)", color: r.direction==="Over" ? C.positive : C.negative, border: `1px solid ${r.direction==="Over" ? "rgba(163,255,87,0.2)" : "rgba(255,61,113,0.2)"}` }}>
                                {r.direction.toUpperCase()}
                              </span>
                            </td>
                            <td className="mobile-pad" style={{ padding: "10px 12px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span className="ev-text" style={{ ...mono, fontSize: 13, fontWeight: 600, color: evColor }}>
                                  {r.ev > 0 ? "+" : ""}{evPct}<span style={{ color: C.muted }}>%</span>
                                </span>
                                <div className="ev-bar" style={{ height: 3, width: barW, background: r.ev > 0 ? C.positive : C.negative }} />
                              </div>
                            </td>
                            <td className="mobile-pad text-sm-mobile" style={{ padding: "10px 12px", ...mono, fontSize: 12 }}>{r.line}</td>
                            <td className="mobile-pad text-sm-mobile" style={{ padding: "10px 12px", ...mono, fontSize: 12, color: C.muted }}>
                              {r.l10Avg != null ? r.l10Avg.toFixed(1) : "—"}
                            </td>
                            <td className="mobile-pad text-sm-mobile" style={{ padding: "10px 12px", ...mono, fontSize: 12, fontWeight: 700, color: C.accent }}>{r.adjLine?.toFixed(1)}</td>
                            <td className="mobile-pad text-sm-mobile" style={{ padding: "10px 12px", ...mono, fontSize: 12, color: r.bookOdds > 0 ? C.positive : C.negative }}>{price}</td>
                            <td className="mobile-pad book-name" style={{ padding: "10px 12px", ...mono, fontSize: 10, color: C.muted }}>
                              {r.bookmaker === "DraftKings" ? "DK" : r.bookmaker === "FanDuel" ? "FD" : r.bookmaker === "BetMGM" ? "MGM" : r.bookmaker}
                            </td>
                            <td className="mobile-pad text-sm-mobile" style={{ padding: "10px 12px" }}>
                              <div style={{ ...mono, fontSize: 10, color: C.muted }}>
                                {r.awayAbbr} <span style={{ color: C.border }}>@</span> {r.homeAbbr}
                              </div>
                            </td>
                            <td className="mobile-pad" style={{ padding: "10px 12px" }}>
                              <span className="stat-badge" style={{ ...mono, fontSize: 9, color: DEF_GRADE_COLOR[r.defGrade], background: `${DEF_GRADE_COLOR[r.defGrade]}18`, border: `1px solid ${DEF_GRADE_COLOR[r.defGrade]}40`, padding: "2px 7px", borderRadius: 2 }}>
                                {r.defGrade}
                              </span>
                            </td>
                            {showAdj && (
                              <td className="mobile-pad text-sm-mobile" style={{ padding: "10px 12px" }}>
                                <div style={{ ...mono, fontSize: 11 }}>{r.gamePace}</div>
                              </td>
                            )}
                            <td className="mobile-pad text-sm-mobile" style={{ padding: "10px 12px", ...mono, fontSize: 12 }}>
                              {(r.modelProb * 100).toFixed(0)}<span style={{ color: C.muted }}>%</span>
                            </td>
                            
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>

          </>}

          {activeTab === "tracker" && (() => {
            const today   = new Date().toISOString().split("T")[0];
            const settled = trackerPlays.filter(p => p.result !== null);
            const hits    = settled.filter(p => p.result === "HIT").length;
            const misses  = settled.filter(p => p.result === "MISS").length;
            const pending = trackerPlays.filter(p => p.result === null && p.date < today).length;
            const hitRate = settled.length ? ((hits / settled.length) * 100).toFixed(0) : "—";
            const byDate  = trackerPlays.reduce((acc, play) => {
              if (!acc[play.date]) acc[play.date] = [];
              acc[play.date].push(play);
              return acc;
            }, {});
            const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

            return (
              <>
                {/* TRACKER SUMMARY */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1, background: C.border, border: `1px solid ${C.border}`, borderRadius: 2, marginBottom: 16, overflow: "hidden" }}>
                  {[
                    { label: "RECORD",   value: `${hits}-${misses}`,                           color: C.neutral  },
                    { label: "HIT RATE", value: hitRate !== "—" ? hitRate + "%" : "—",         color: C.positive },
                    { label: "PENDING",  value: pending,                                       color: C.accent   },
                    { label: "TRACKED",  value: trackerPlays.length,                           color: C.muted    },
                  ].map(cell => (
                    <div key={cell.label} style={{ background: C.surface, padding: "12px 16px" }}>
                      <div style={{ ...mono, fontSize: 9, letterSpacing: 2, color: C.muted, marginBottom: 3 }}>{cell.label}</div>
                      <div style={{ ...mono, fontSize: 24, fontWeight: 900, letterSpacing: 2, color: cell.color, lineHeight: 1 }}>{cell.value}</div>
                    </div>
                  ))}
                </div>

                {/* TRACKER ACTIONS */}
                <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    onClick={checkResults}
                    disabled={checkingResults || pending === 0}
                    style={{ background: checkingResults || pending === 0 ? "transparent" : C.accent, color: checkingResults || pending === 0 ? C.muted : C.bg, border: `1px solid ${checkingResults || pending === 0 ? C.border : C.accent}`, borderRadius: 2, padding: "8px 20px", ...mono, fontSize: 11, fontWeight: 900, letterSpacing: 2, cursor: checkingResults || pending === 0 ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
                  >
                    {checkingResults ? "CHECKING…" : `CHECK RESULTS (${pending} PENDING)`}
                  </button>
                  <button
                    onClick={() => { if (!window.confirm("Clear all tracked plays?")) return; setTrackerPlays([]); localStorage.removeItem("edge_tracker"); }}
                    style={{ background: "transparent", border: `1px solid rgba(255,61,113,0.3)`, color: C.negative, borderRadius: 2, padding: "8px 14px", ...mono, fontSize: 10, letterSpacing: 2, cursor: "pointer" }}
                  >
                    CLEAR ALL
                  </button>
                  <span style={{ ...mono, fontSize: 9, color: C.muted, marginLeft: "auto", opacity: 0.6 }}>
                    Top 10 EV plays auto-saved on each fetch · results via ESPN boxscores
                  </span>
                </div>

                {/* PLAYS BY DATE */}
                {trackerPlays.length === 0 ? (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 2, padding: "80px 40px", textAlign: "center" }}>
                    <div style={{ ...mono, fontSize: 40, color: C.border }}>◈</div>
                    <div style={{ ...mono, fontSize: 14, letterSpacing: 4, color: C.muted, marginTop: 14 }}>NO PLAYS TRACKED YET</div>
                    <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>Go to PROPS, fetch live odds — top 10 EV plays are saved automatically.</div>
                  </div>
                ) : dates.map(date => {
                  const plays       = byDate[date];
                  const dateHits    = plays.filter(p => p.result === "HIT").length;
                  const dateMisses  = plays.filter(p => p.result === "MISS").length;
                  const datePending = plays.filter(p => p.result === null && date < today).length;
                  const isToday     = date === today;
                  return (
                    <div key={date} style={{ marginBottom: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                        <span style={{ ...mono, fontSize: 11, letterSpacing: 3, color: C.accent }}>{date}</span>
                        {isToday    && <span style={{ ...mono, fontSize: 8, letterSpacing: 2, color: C.accent, background: "rgba(0,229,255,0.1)", border: `1px solid rgba(0,229,255,0.3)`, borderRadius: 2, padding: "1px 5px" }}>TODAY</span>}
                        {dateHits   > 0 && <span style={{ ...mono, fontSize: 10, color: C.positive }}>{dateHits}W</span>}
                        {dateMisses > 0 && <span style={{ ...mono, fontSize: 10, color: C.negative }}>{dateMisses}L</span>}
                        {datePending > 0 && <span style={{ ...mono, fontSize: 10, color: C.muted }}>{datePending} pending</span>}
                      </div>
                      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 2, overflow: "hidden" }}>
                        <div className="table-container">
                          <table style={{ width: "100%", borderCollapse: "collapse" }}>
                            <thead>
                              <tr style={{ background: C.surface2, borderBottom: `1px solid ${C.border}` }}>
                                {["PLAYER","STAT","DIR","LINE","EV%","ODDS","BOOK","MATCHUP","RESULT"].map(h => (
                                  <th key={h} style={{ padding: "8px 12px", textAlign: "left", ...mono, fontSize: 9, letterSpacing: 2, color: C.muted, whiteSpace: "nowrap" }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {plays.map((p, i) => {
                                const priceStr     = p.bookOdds > 0 ? `+${p.bookOdds}` : `${p.bookOdds}`;
                                const resultColor  = p.result === "HIT" ? C.positive : p.result === "MISS" ? C.negative : C.muted;
                                const resultBg     = p.result === "HIT" ? "rgba(163,255,87,0.1)" : p.result === "MISS" ? "rgba(255,61,113,0.1)" : "rgba(74,96,112,0.1)";
                                const resultBorder = p.result === "HIT" ? "rgba(163,255,87,0.3)" : p.result === "MISS" ? "rgba(255,61,113,0.3)" : "rgba(74,96,112,0.3)";
                                const resultLabel  = p.result ?? (isToday ? "TODAY" : "PENDING");
                                return (
                                  <tr key={p.id || i} style={{ borderBottom: `1px solid rgba(30,45,61,0.5)`, background: i%2===0 ? "transparent" : "rgba(20,28,36,0.3)" }}>
                                    <td style={{ padding: "9px 12px", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" }}>{p.player}</td>
                                    <td style={{ padding: "9px 12px" }}>
                                      <span style={{ background: C.surface2, border: `1px solid ${C.border}`, padding: "2px 7px", borderRadius: 2, ...mono, fontSize: 9, color: C.neutral }}>{p.market}</span>
                                    </td>
                                    <td style={{ padding: "9px 12px" }}>
                                      <span style={{ padding: "2px 7px", borderRadius: 2, ...mono, fontSize: 9, fontWeight: 600, background: p.direction==="Over" ? "rgba(163,255,87,0.1)" : "rgba(255,61,113,0.1)", color: p.direction==="Over" ? C.positive : C.negative, border: `1px solid ${p.direction==="Over" ? "rgba(163,255,87,0.2)" : "rgba(255,61,113,0.2)"}` }}>
                                        {p.direction.toUpperCase()}
                                      </span>
                                    </td>
                                    <td style={{ padding: "9px 12px", ...mono, fontSize: 12 }}>{p.line}</td>
                                    <td style={{ padding: "9px 12px", ...mono, fontSize: 12, fontWeight: 600, color: p.ev > 0 ? C.positive : C.negative }}>
                                      {p.ev > 0 ? "+" : ""}{(p.ev * 100).toFixed(1)}%
                                    </td>
                                    <td style={{ padding: "9px 12px", ...mono, fontSize: 12, color: p.bookOdds > 0 ? C.positive : C.negative }}>{priceStr}</td>
                                    <td style={{ padding: "9px 12px", ...mono, fontSize: 10, color: C.muted }}>
                                      {p.bookmaker === "DraftKings" ? "DK" : p.bookmaker === "FanDuel" ? "FD" : p.bookmaker}
                                    </td>
                                    <td style={{ padding: "9px 12px", ...mono, fontSize: 10, color: C.muted, whiteSpace: "nowrap" }}>
                                      {p.awayAbbr} @ {p.homeAbbr}
                                    </td>
                                    <td style={{ padding: "9px 12px" }}>
                                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                        <span style={{ padding: "2px 7px", borderRadius: 2, ...mono, fontSize: 9, fontWeight: 700, color: resultColor, background: resultBg, border: `1px solid ${resultBorder}`, whiteSpace: "nowrap" }}>
                                          {resultLabel}
                                        </span>
                                        {p.actual !== null && (
                                          <span style={{ ...mono, fontSize: 10, color: C.muted }}>({p.actual})</span>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            );
          })()}

          <div style={{ ...mono, fontSize: 9, color: C.muted, opacity: 0.4, marginTop: 10, letterSpacing: 1 }}>
            // LIVE ODDS: THE ODDS API · BOOKS: DRAFTKINGS · FANDUEL · BETMGM · MODEL: DEF RTG + PACE + HOME/AWAY · FOR EDUCATIONAL USE ONLY
          </div>
        </div>
      </div>
    </div>
  );
}
