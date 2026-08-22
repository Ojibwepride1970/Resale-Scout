import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

function loadDotEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i+1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotEnv();

let ebayToken = null;
let ebayTokenExpires = 0;

async function getEbayToken() {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) return null;
  if (ebayToken && Date.now() < ebayTokenExpires - 60000) return ebayToken;

  const creds = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope"
  });
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  if (!r.ok) throw new Error(`eBay OAuth failed (${r.status})`);
  const j = await r.json();
  ebayToken = j.access_token;
  ebayTokenExpires = Date.now() + (j.expires_in || 7200) * 1000;
  return ebayToken;
}

async function ebayActiveComps(query) {
  const token = await getEbayToken();
  if (!token) return { configured:false, listings:[], median:null };
  const market = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
 const isBarcode = /^\d{8,14}$/.test(String(query).trim());

if (isBarcode) {
  url.searchParams.set("gtin", String(query).trim());
} else {
  url.searchParams.set("q", query);
}
  url.searchParams.set("limit", "20");
  url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE|BEST_OFFER}");
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": market
    }
  });
  if (!r.ok) throw new Error(`eBay Browse search failed (${r.status})`);
  const j = await r.json();
 const listings = (j.itemSummaries || []).map(x => ({
  title: x.title,
  price: Number(x.price?.value || 0),
  currency: x.price?.currency || "USD",
  condition: x.condition || "",
image:
  x.image?.imageUrl ||
  x.thumbnailImages?.[0]?.imageUrl ||
  "",
url: x.itemWebUrl || ""
 
})).filter(x => x.price > 0);
  const vals = listings.map(x=>x.price).sort((a,b)=>a-b);
  const median = vals.length ? (vals.length % 2 ? vals[(vals.length-1)/2] : (vals[vals.length/2-1]+vals[vals.length/2])/2) : null;
  return {configured:true, listings, median};
}

async function soldComps(query) {
  if (!process.env.SOLD_COMPS_API_URL || !process.env.SOLD_COMPS_API_KEY) {
    return {
      configured: false,
      comps: [],
      median: null
    };
  }

  const u = new URL(process.env.SOLD_COMPS_API_URL);

  u.searchParams.set("query", query);
  u.searchParams.set("show_only", "sold_items");
  u.searchParams.set("domain", "com");
  u.searchParams.set("page", "1");
if (process.env.EBAY_SESSION_COOKIE) {
  u.searchParams.set("cookie", process.env.EBAY_SESSION_COOKIE);
}
 const r = await fetch(u, {
  headers: {
    "x-api-key": process.env.SOLD_COMPS_API_KEY
  }
});

  if (!r.ok) {
    const text = await r.text();
    throw new Error(
      `Sold comps provider failed (${r.status}): ${text.slice(0, 200)}`
    );
  }

  const j = await r.json();

  const products = Array.isArray(j?.data?.products)
    ? j.data.products
    : [];

  const comps = products
    .map((item) => ({
      title: item.title || "",
      price: Number(item.price || 0),
      currency: item.currency || "USD",
      condition: item.condition || "",
      image: item.image || item.image_high_res || "",
      url: item.url || "",
      soldDate: item.caption || ""
    }))
    .filter((item) => item.price > 0);

  const prices = comps
    .map((item) => item.price)
    .sort((a, b) => a - b);

  const median = prices.length
    ? prices.length % 2
      ? prices[(prices.length - 1) / 2]
      : (
          prices[prices.length / 2 - 1] +
          prices[prices.length / 2]
        ) / 2
    : null;

  return {
    configured: true,
    comps,
    median,
    count: comps.length
  };
}

function cleanJsonText(s) {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return s.slice(start, end+1);
  return s;
}

app.get("/api/status", (req,res) => {
  res.json({
    vision: !!process.env.OPENAI_API_KEY,
    ebayActive: !!(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET),
    soldComps: !!process.env.SOLD_COMPS_API_URL
  });
});

app.post("/api/analyze", async (req,res) => {
  try {
    const { imageDataUrl, notes="", minProfit=25, feePercent=14, shippingDefault=8 } = req.body || {};
    if (!imageDataUrl) return res.status(400).json({error:"Missing image"});
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({error:"Real image analysis is not configured. Add OPENAI_API_KEY to .env."});
    }

    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const prompt = `You are Resale Scout, an expert eBay resale assistant.

Analyze every distinct potentially resellable item visible in the photo.

For EACH item, you MUST return ALL of these fields:

- name
- brand
- ebaySearch
- estimatedResale
- maxBuyPrice
- estimatedProfit
- confidence
- recommendation
- reason

Rules:
- Do not invent a brand or model if it cannot be seen.
- Use "Unknown" when the brand is not identifiable.
- estimatedResale must be a realistic eBay resale price range such as "$25-$40".
- maxBuyPrice must be the highest price a reseller should pay and still have reasonable profit.
- estimatedProfit must account for roughly 14% eBay fees plus normal selling costs.
- confidence must be exactly HIGH, MEDIUM, or LOW.
- recommendation must be exactly BUY, MAYBE, or SKIP.
- reason must briefly explain why the item received that recommendation.
- ebaySearch must be a concise phrase useful for searching eBay sold listings.

Never omit a field. If you are uncertain, still provide your best estimate and lower the confidence level.

Return ONLY valid JSON in exactly this structure:

{
  "items": [
    {
      "name": "example item",
      "brand": "Unknown",
      "ebaySearch": "example eBay search",
      "estimatedResale": "$25-$40",
      "maxBuyPrice": "$10",
      "estimatedProfit": "$10-$20",
      "confidence": "MEDIUM",
      "recommendation": "MAYBE",
      "reason": "Identification or demand is somewhat uncertain."
    }
  ]
}

Do not include markdown, code fences, commentary, or any text outside the JSON.`;

    const rr = await fetch("https://api.openai.com/v1/responses", {
      method:"POST",
      headers:{
        "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify({
        model,
        input:[{
          role:"user",
          content:[
            {type:"input_text", text:prompt},
            {type:"input_image", image_url:imageDataUrl}
          ]
        }]
      })
    });
    if (!rr.ok) {
      const txt = await rr.text();
      throw new Error(`Vision API failed (${rr.status}): ${txt.slice(0,300)}`);
    }
    const data = await rr.json();
    const outputText =
      data.output_text ||
      (data.output || []).flatMap(o => o.content || []).map(c => c.text || "").join("\n");
    const parsed = JSON.parse(cleanJsonText(outputText));
    const items = Array.isArray(parsed.items) ? parsed.items.slice(0,12) : [];

    for (const it of items) {
     const q = it.ebaySearch || it.searchQuery || [it.brand,it.model,it.name].filter(Boolean).join(" ");
const [activeResult, soldResult] = await Promise.allSettled([
  ebayActiveComps(q),
  soldComps(q)
]);

if (activeResult.status === "fulfilled") {
  it.activeComps = activeResult.value;
} else {
  console.error("EBAY ACTIVE COMPS ERROR:", activeResult.reason);
  it.activeComps = {
    configured: true,
    listings: [],
    median: null,
    error:
      activeResult.reason?.message ||
      String(activeResult.reason)
  };
}

if (soldResult.status === "fulfilled") {
  it.soldComps = soldResult.value;
} else {
  console.error("SOLD COMPS ERROR:", soldResult.reason);
  it.soldComps = {
    configured: true,
    comps: [],
    median: null,
    error:
      soldResult.reason?.message ||
      String(soldResult.reason)
  };
}

const soldMedian = Number(it.soldComps?.median || 0);
const activeMedian = Number(it.activeComps?.median || 0);
const marketPrice = soldMedian || activeMedian;
const marketSource = soldMedian ? "SOLD" : "ACTIVE";
const soldCount =
  Number(it.soldComps?.count || it.soldComps?.comps?.length || 0);

const activeCount =
  Number(it.activeComps?.listings?.length || 0);

const sellThroughRate =
  activeCount > 0
    ? (soldCount / activeCount) * 100
    : soldCount > 0
    ? 100
    : 0;

let sellThroughLabel = "🐢 SLOW";

if (sellThroughRate >= 100) {
  sellThroughLabel = "🔥 FAST";
} else if (sellThroughRate >= 50) {
  sellThroughLabel = "👍 GOOD";
}
if (marketPrice > 0) {

  const fees = marketPrice * (feePercent / 100);
  const availableAfterCosts =
    marketPrice - fees - shippingDefault;
const targetProfit = Math.min(
  minProfit,
  Math.max(4, marketPrice * 0.30)
);

const suggestedMaxBuy = Math.max(
  0,
  availableAfterCosts - targetProfit
);

  const aiMaxBuy =
    Number(
      String(it.maxBuyPrice || "")
        .replace(/[^0-9.]/g, "")
    ) || 0;

const actualBuyPrice =
  suggestedMaxBuy > 0
    ? Math.min(aiMaxBuy || suggestedMaxBuy, suggestedMaxBuy)
    : 0;

  const marketProfit =
    marketPrice -
    fees -
    shippingDefault -
    actualBuyPrice;

it.marketAnalysis = {
  medianPrice: Number(marketPrice.toFixed(2)),
  suggestedMaxBuy: Number(suggestedMaxBuy.toFixed(2)),
  estimatedProfit: Number(marketProfit.toFixed(2)),
  source: marketSource,
  listingCount: activeCount,
  soldCount: soldCount,
  activeCount: activeCount,
  sellThroughRate: Number(sellThroughRate.toFixed(1)),
  sellThroughLabel: sellThroughLabel
};

 const profitMargin =
  marketPrice > 0
    ? (marketProfit / marketPrice) * 100
    : 0;

if (
  sellThroughLabel.includes("FAST") &&
  marketProfit >= 6 &&
  profitMargin >= 20
) {
  it.marketRecommendation = "BUY";

} else if (
  sellThroughLabel.includes("GOOD") &&
  marketProfit >= 8 &&
  profitMargin >= 25
) {
  it.marketRecommendation = "BUY";

} else if (
  sellThroughLabel.includes("SLOW") &&
  marketProfit >= 12 &&
  profitMargin >= 35
) {
  it.marketRecommendation = "BUY";

} else if (
  marketProfit >= 4 &&
  profitMargin >= 20
) {
  it.marketRecommendation = "MAYBE";

} else {
  it.marketRecommendation = "SKIP";
}
}
      
     
    }

    res.json({items, assumptions:{minProfit,feePercent,shippingDefault}});
  } catch (e) {
    res.status(500).json({error:e.message || String(e)});
  }
});

app.get("/api/barcode/:code", async (req,res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return res.status(400).json({error:"Missing barcode"});
    const comps = await ebayActiveComps(code);
    res.json({code, comps});
  } catch(e) {
    res.status(500).json({error:e.message || String(e)});
  }
 
});

app.use((req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

const port = Number(process.env.PORT || 3000);
app.listen(port, ()=>console.log(`Resale Scout running at http://localhost:${port}`));
