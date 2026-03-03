// api/odds.js — Vercel Serverless Function
// This runs server-side, so your API key is never exposed to the browser.

const ODDS_API_KEY = process.env.ODDS_API_KEY || "33f7c85a41bd0aefe34d0c4e5fac6021";
const ODDS_BASE    = "https://api.the-odds-api.com/v4";

export default async function handler(req, res) {
  // Allow requests from your own frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { path, ...queryParams } = req.query;

  if (!path) {
    return res.status(400).json({ error: "Missing path parameter" });
  }

  // Build the Odds API URL from the path + query params passed by the frontend
  const searchParams = new URLSearchParams({
    ...queryParams,
    apiKey: ODDS_API_KEY,
  });

  const url = `${ODDS_BASE}/${path}?${searchParams.toString()}`;

  try {
    const apiRes = await fetch(url);

    // Forward the remaining/used headers so the frontend can track budget
    const remaining = apiRes.headers.get("x-requests-remaining");
    const used      = apiRes.headers.get("x-requests-used");
    if (remaining) res.setHeader("x-requests-remaining", remaining);
    if (used)      res.setHeader("x-requests-used", used);

    const data = await apiRes.json();

    if (!apiRes.ok) {
      return res.status(apiRes.status).json(data);
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
