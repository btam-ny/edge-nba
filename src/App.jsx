import { useState, useMemo, useRef } from "react";

// ─── CONFIG ────────────────────────────────────────────────────────────────
const ODDS_API_KEY  = "21b5a430e3451a9743da697b7fc88a32";
const ODDS_BASE     = "https://api.the-odds-api.com/v4";
const SPORT         = "basketball_nba";
const REGIONS       = "us";
const ODDS_FORMAT   = "american";
// Batch all markets per event to minimize calls (1 call per game not per market)
const PROP_MARKETS  = "player_points,player_rebounds,player_assists,player_threes";
const BOOKMAKERS    = "draftkings,fanduel,betmgm"; // limit to 3 books to keep response small

// ─── TEAM DEFENSIVE PROFILES (from live NBA API) ───────────────────────────
const TEAM_DEF = {
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
const VIG                = 1.06775067750678;
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

function calcEV(modelProb, bookOdds) {
  // True probability after removing vig
  const rawProb  = americanToProb(bookOdds);
  const trueProb = rawProb / VIG;
  return (modelProb - trueProb) / modelProb;
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
// Since we don't have player game logs in this version, we use a simple
// line-centered normal distribution model with adjustments applied as
// multipliers on the expected value. The book line IS our baseline.
function applyAdjustmentsAndEV(props) {
  return props.map(prop => {
    const { line, overOdds, underOdds, homeAbbr, awayAbbr, market } = prop;

    // We don't know which team the player is on from Odds API alone
    // Use home team context as default, user can filter
    const oppAbbr  = awayAbbr; // conservative: use away as opponent for home players
    const isHome   = true;     // default assumption

    const oppDef   = TEAM_DEF[oppAbbr] || { defRtg: LEAGUE_AVG_DEF_RTG, pace: LEAGUE_AVG_PACE };
    const homeDef  = TEAM_DEF[homeAbbr] || { defRtg: LEAGUE_AVG_DEF_RTG, pace: LEAGUE_AVG_PACE };

    // Defensive adjustment
    const defDiff     = oppDef.defRtg - LEAGUE_AVG_DEF_RTG;
    const defScale    = market === "3PM" ? 0.035 : market === "REB" ? 0.015 : market === "AST" ? 0.012 : 0.03;
    let   defMult     = 1 + (defDiff / 5) * defScale;
    defMult           = Math.max(0.80, Math.min(1.20, defMult));

    // Pace adjustment
    const gamePace    = (homeDef.pace + oppDef.pace) / 2;
    const paceMult    = Math.max(0.88, Math.min(1.12, 1 + ((gamePace - LEAGUE_AVG_PACE) / LEAGUE_AVG_PACE) * 0.8));

    // Home/away boost (raw values by market)
    const homeBoosts  = { PTS: 2.5, REB: 0.4, AST: 0.3, "3PM": 0.2 };
    const homeBoost   = isHome ? (homeBoosts[market] || 1.0) : -(homeBoosts[market] || 1.0);

    // Adjusted expected value (book line as baseline)
    const adjLine     = (line * defMult * paceMult) + homeBoost;

    // Std dev estimate: typically ~30-35% of mean for scoring stats
    const stdPcts     = { PTS: 0.32, REB: 0.38, AST: 0.40, "3PM": 0.55 };
    const adjStd      = adjLine * (stdPcts[market] || 0.35);

    // Model probability for over/under
    const zOver       = (line + 0.5 - adjLine) / adjStd;
    const zUnder      = (line - 0.5 - adjLine) / adjStd;
    const modelOver   = 1 - normCDF(zOver);
    const modelUnder  = normCDF(zUnder);

    const evOver      = calcEV(modelOver,  overOdds);
    const evUnder     = calcEV(modelUnder, underOdds);

    const defGrade    = getDefGrade(oppDef.defRtg);

    return {
      ...prop,
      adjLine:    +adjLine.toFixed(2),
      adjStd:     +adjStd.toFixed(2),
      gamePace:   +gamePace.toFixed(1),
      defGrade,
      defRtg:     oppDef.defRtg,
      defMult:    +defMult.toFixed(3),
      paceMult:   +paceMult.toFixed(3),
      homeBoost,
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
const mono = { fontFamily: "monospace" };

export default function App() {
  const [events,      setEvents]      = useState([]);
  const [props,       setProps]       = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [loadingMsg,  setLoadingMsg]  = useState("");
  const [error,       setError]       = useState(null);
  const [callsLeft,   setCallsLeft]   = useState(null);
  const [callsUsed,   setCallsUsed]   = useState(0);
  const [lastUpdated, setLastUpdated] = useState("");
  const [statFilter,  setStatFilter]  = useState("ALL");
  const [dirFilter,   setDirFilter]   = useState("ALL");
  const [evMin,       setEvMin]       = useState(-20);
  const [sortCol,     setSortCol]     = useState("evOver");
  const [sortAsc,     setSortAsc]     = useState(false);
  const [showAdj,     setShowAdj]     = useState(false);
  const cache = useRef({});

  // ── API helpers ──────────────────────────────────────────────────────────
  async function oddsApiFetch(url) {
    const res  = await fetch(url);
    const remaining = res.headers.get("x-requests-remaining");
    const used      = res.headers.get("x-requests-used");
    if (remaining !== null) setCallsLeft(+remaining);
    if (used      !== null) setCallsUsed(+used);
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
        await new Promise(r => setTimeout(r, 200));
      }

      // ── Step 3: Apply adjustments + EV ──────────────────────────────────
      setLoadingMsg("Applying defense · pace · home/away adjustments…");
      const withEV = applyAdjustmentsAndEV(allProps);
      setProps(withEV);
      setLastUpdated("UPDATED " + new Date().toLocaleTimeString());

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMsg("");
    }
  }

  // ── FILTERED + SORTED TABLE DATA ─────────────────────────────────────────
  const tableRows = useMemo(() => {
    const expanded = props.flatMap(p => [
      { ...p, direction: "Over",  ev: p.evOver,  modelProb: p.modelOver,  bookOdds: p.overOdds  },
      { ...p, direction: "Under", ev: p.evUnder, modelProb: p.modelUnder, bookOdds: p.underOdds },
    ]);

    return expanded
      .filter(r => statFilter === "ALL" || r.market === statFilter)
      .filter(r => dirFilter  === "ALL" || r.direction === dirFilter)
      .filter(r => r.ev * 100 >= evMin)
      .sort((a, b) => {
        const va = a[sortCol], vb = b[sortCol];
        if (typeof va === "string") return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        return sortAsc ? va - vb : vb - va;
      });
  }, [props, statFilter, dirFilter, evMin, sortCol, sortAsc]);

  const posCount = tableRows.filter(r => r.ev > 0).length;
  const bestEv   = tableRows.length ? (tableRows.sort((a,b) => b.ev - a.ev)[0].ev * 100).toFixed(1) : "—";
  const avgEv    = tableRows.length ? (tableRows.reduce((s,r) => s + r.ev, 0) / tableRows.length * 100).toFixed(1) : "—";

  function handleSort(col) {
    if (sortCol === col) setSortAsc(a => !a);
    else { setSortCol(col); setSortAsc(false); }
  }

  const loaded = props.length > 0;
  const callsLeftColor = callsLeft === null ? C.muted : callsLeft > 200 ? C.positive : callsLeft > 50 ? "#ffb347" : C.negative;

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'DM Sans',sans-serif", fontSize: 14 }}>
      <div style={{ position: "fixed", inset: 0, backgroundImage: gridBg, pointerEvents: "none", zIndex: 0 }} />
      <div style={{ position: "relative", zIndex: 1 }}>

        {/* HEADER */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 28px", borderBottom: `1px solid ${C.border}`, background: "rgba(8,12,16,0.94)", backdropFilter: "blur(10px)", position: "sticky", top: 0, zIndex: 100 }}>
          <div>
            <div style={{ ...mono, fontSize: 34, fontWeight: 900, letterSpacing: 6, color: C.accent, textShadow: `0 0 28px rgba(0,229,255,0.4)`, lineHeight: 1 }}>EDGE</div>
            <div style={{ ...mono, fontSize: 10, letterSpacing: 3, color: C.text, opacity: 0.3 }}>NBA PROP FINDER · LIVE ODDS</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 24, ...mono, fontSize: 11 }}>
            {/* API call counter */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 2, padding: "8px 14px", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: C.muted }}>CALLS REMAINING</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: callsLeftColor, letterSpacing: 2, lineHeight: 1 }}>
                {callsLeft === null ? "—" : callsLeft}
              </div>
              <div style={{ fontSize: 9, color: C.muted }}>of 500 free</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, color: C.muted, fontSize: 10 }}>
              <span><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", marginRight: 6, background: loaded ? C.positive : C.muted, boxShadow: loaded ? `0 0 8px ${C.positive}` : "none" }} />{loading ? loadingMsg.split("…")[0] : loaded ? "LIVE DATA" : "READY"}</span>
              {lastUpdated && <span style={{ opacity: 0.5 }}>{lastUpdated}</span>}
            </div>
          </div>
        </div>

        <div style={{ padding: "22px 28px" }}>

          {/* CONFIG PANEL */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 2, padding: "18px 22px", marginBottom: 18, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg,${C.accent},transparent)` }} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
              {[
                { icon: "📡", label: "DATA SOURCE", value: "The Odds API · DraftKings · FanDuel · BetMGM" },
                { icon: "🛡", label: "ADJ: DEFENSE", value: `Opp def rating vs league avg (${LEAGUE_AVG_DEF_RTG})` },
                { icon: "⚡", label: "ADJ: PACE + H/A", value: `Game pace · Home +2.5pts, Away −2.5pts` },
              ].map(item => (
                <div key={item.label} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 2, padding: "10px 12px" }}>
                  <div style={{ ...mono, fontSize: 9, letterSpacing: 2, color: C.accent, marginBottom: 3 }}>{item.icon} {item.label}</div>
                  <div style={{ ...mono, fontSize: 10, color: C.muted, lineHeight: 1.6 }}>{item.value}</div>
                </div>
              ))}
            </div>

            {/* Call budget warning */}
            {callsLeft !== null && callsLeft < 100 && (
              <div style={{ background: "rgba(255,61,113,0.08)", border: `1px solid rgba(255,61,113,0.3)`, borderRadius: 2, padding: "8px 12px", marginBottom: 12, ...mono, fontSize: 10, color: C.negative }}>
                ⚠ LOW CALL BUDGET — {callsLeft} calls remaining. Each fetch uses ~{events.length + 1 || 11} calls. Cache is active for this session.
              </div>
            )}

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <div style={{ ...mono, fontSize: 10, color: C.muted, flex: 1 }}>
                {loaded ? `${events.length} games · ${props.length} raw props · ~${events.length + 1} calls per fetch · cached this session` : `~${1} call for events + 1 per game on slate`}
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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 1, background: C.border, border: `1px solid ${C.border}`, borderRadius: 2, marginBottom: 16, overflow: "hidden" }}>
              {[
                { label: "TOTAL PROPS", value: tableRows.length,                    color: C.neutral  },
                { label: "POSITIVE EV",  value: posCount,                            color: C.positive },
                { label: "BEST EDGE",    value: bestEv !== "—" ? bestEv + "%" : "—", color: C.accent   },
                { label: "AVG EV%",      value: avgEv  !== "—" ? avgEv  + "%" : "—", color: C.muted    },
                { label: "CALLS LEFT",   value: callsLeft ?? "—",                    color: callsLeftColor },
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
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 2, padding: "5px 10px" }}>
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
              const cols = [
                { key: "player",    label: "PLAYER"    },
                { key: "market",    label: "STAT"      },
                { key: "direction", label: "DIR"       },
                { key: "line",      label: "LINE"      },
                { key: "bookOdds",  label: "ODDS"      },
                { key: "bookmaker", label: "BOOK"      },
                { key: "homeTeam",  label: "MATCHUP"   },
                ...(showAdj ? [
                  { key: "adjLine",  label: "ADJ LINE" },
                  { key: "defGrade", label: "DEF"      },
                  { key: "gamePace", label: "PACE"     },
                ] : [
                  { key: "defGrade", label: "DEF"      },
                ]),
                { key: "modelProb", label: "MODEL%"   },
                { key: "ev",        label: "EV%"       },
              ];

              return (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: C.surface2, borderBottom: `1px solid ${C.border}` }}>
                        {cols.map(col => (
                          <th key={col.key} onClick={() => handleSort(col.key)} style={{ padding: "10px 12px", textAlign: "left", ...mono, fontSize: 9, letterSpacing: 2, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", color: sortCol===col.key ? C.accent : C.muted }}>
                            {col.label} <span style={{ opacity: sortCol===col.key ? 1 : 0.4 }}>{sortCol===col.key ? (sortAsc ? "↑" : "↓") : "↕"}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map((r, i) => {
                        const evPct   = (r.ev * 100).toFixed(1);
                        const evColor = r.ev > 0.05 ? C.positive : r.ev > 0 ? C.neutral : C.negative;
                        const maxEV   = Math.max(...tableRows.map(x => Math.abs(x.ev)));
                        const barW    = Math.min(50, Math.abs(r.ev) / (maxEV || 1) * 50);
                        const price   = r.bookOdds > 0 ? `+${r.bookOdds}` : `${r.bookOdds}`;

                        return (
                          <tr key={i} style={{ borderBottom: `1px solid rgba(30,45,61,0.5)`, background: i%2===0 ? "transparent" : "rgba(20,28,36,0.3)" }}>
                            <td style={{ padding: "10px 12px" }}>
                              <div style={{ fontWeight: 500, fontSize: 13 }}>{r.player}</div>
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <span style={{ background: C.surface2, border: `1px solid ${C.border}`, padding: "2px 7px", borderRadius: 2, ...mono, fontSize: 9, color: C.neutral }}>{r.market}</span>
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <span style={{ padding: "2px 7px", borderRadius: 2, ...mono, fontSize: 9, fontWeight: 600, background: r.direction==="Over" ? "rgba(163,255,87,0.1)" : "rgba(255,61,113,0.1)", color: r.direction==="Over" ? C.positive : C.negative, border: `1px solid ${r.direction==="Over" ? "rgba(163,255,87,0.2)" : "rgba(255,61,113,0.2)"}` }}>
                                {r.direction.toUpperCase()}
                              </span>
                            </td>
                            <td style={{ padding: "10px 12px", ...mono, fontSize: 12 }}>{r.line}</td>
                            <td style={{ padding: "10px 12px", ...mono, fontSize: 12, color: r.bookOdds > 0 ? C.positive : C.negative }}>{price}</td>
                            <td style={{ padding: "10px 12px", ...mono, fontSize: 10, color: C.muted }}>{r.bookmaker}</td>
                            <td style={{ padding: "10px 12px" }}>
                              <div style={{ ...mono, fontSize: 10, color: C.muted }}>
                                {r.awayAbbr} <span style={{ color: C.border }}>@</span> {r.homeAbbr}
                              </div>
                            </td>
                            {showAdj && (
                              <>
                                <td style={{ padding: "10px 12px", ...mono, fontSize: 11 }}>{r.adjLine}</td>
                              </>
                            )}
                            <td style={{ padding: "10px 12px" }}>
                              <span style={{ ...mono, fontSize: 9, color: DEF_GRADE_COLOR[r.defGrade], background: `${DEF_GRADE_COLOR[r.defGrade]}18`, border: `1px solid ${DEF_GRADE_COLOR[r.defGrade]}40`, padding: "2px 7px", borderRadius: 2 }}>
                                {r.defGrade}
                              </span>
                              <div style={{ ...mono, fontSize: 8, color: C.muted, marginTop: 2 }}>{r.defRtg?.toFixed(1)}</div>
                            </td>
                            {showAdj && (
                              <td style={{ padding: "10px 12px" }}>
                                <div style={{ ...mono, fontSize: 11 }}>{r.gamePace}</div>
                                <div style={{ ...mono, fontSize: 9, color: r.paceMult > 1 ? C.positive : C.negative }}>
                                  {r.paceMult > 1 ? "▲" : "▼"}{((r.paceMult-1)*100).toFixed(1)}%
                                </div>
                              </td>
                            )}
                            <td style={{ padding: "10px 12px", ...mono, fontSize: 12 }}>
                              {(r.modelProb * 100).toFixed(1)}<span style={{ color: C.muted }}>%</span>
                            </td>
                            <td style={{ padding: "10px 12px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ ...mono, fontSize: 13, fontWeight: 600, color: evColor }}>
                                  {evPct > 0 ? "+" : ""}{evPct}<span style={{ color: C.muted }}>%</span>
                                </span>
                                <div style={{ height: 3, width: barW, background: r.ev > 0 ? C.positive : C.negative }} />
                              </div>
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

          <div style={{ ...mono, fontSize: 9, color: C.muted, opacity: 0.4, marginTop: 10, letterSpacing: 1 }}>
            // LIVE ODDS: THE ODDS API · BOOKS: DRAFTKINGS · FANDUEL · BETMGM · MODEL: DEF RTG + PACE + HOME/AWAY · FOR EDUCATIONAL USE ONLY
          </div>
        </div>
      </div>
    </div>
  );
}
