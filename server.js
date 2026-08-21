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
  url.searchParams.set("q", query);
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
    url: x.itemWebUrl || ""
  })).filter(x => x.price > 0);
  const vals = listings.map(x=>x.price).sort((a,b)=>a-b);
  const median = vals.length ? (vals.length % 2 ? vals[(vals.length-1)/2] : (vals[vals.length/2-1]+vals[vals.length/2])/2) : null;
  return {configured:true, listings, median};
}

async function soldComps(query) {
  // Optional connector for any licensed sold-history provider the owner chooses.
  if (!process.env.SOLD_COMPS_API_URL) return {configured:false, comps:[], median:null};
  const u = new URL(process.env.SOLD_COMPS_API_URL);
  u.searchParams.set("q", query);
  const r = await fetch(u, {
    headers: process.env.SOLD_COMPS_API_KEY ? {"Authorization":`Bearer ${process.env.SOLD_COMPS_API_KEY}`} : {}
  });
  if (!r.ok) throw new Error(`Sold comps provider failed (${r.status})`);
  const j = await r.json();
  return j;
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
 const prompt = `You are Resale Scout, an expert assistant for an eBay reseller shopping at thrift stores, garage sales, flea markets, and estate sales.

Analyze every distinct potentially resellable item visible in the photo.

For each item:
- Identify the item as specifically as the image allows.
- Do NOT invent a brand, model, age, material, or feature you cannot see.
- Give a useful eBay search phrase.
- Estimate a realistic eBay resale price range.
- Recommend the MAXIMUM purchase price that would leave room for profit.
- Estimate the potential profit after approximately 14% eBay fees and normal selling costs.
- Give a confidence level: HIGH, MEDIUM, or LOW.
- Give a recommendation: BUY, MAYBE, or SKIP.

Use BUY when the likely profit and demand appear worthwhile.
Use MAYBE when identification, value, condition, or demand is uncertain.
Use SKIP when expected resale value or profit appears too low.

Return ONLY valid JSON in exactly this structure:

{
  "items": [
    {
      "name": "item name",
      "brand": "brand if visible, otherwise Unknown",
      "ebaySearch": "useful eBay search phrase",
      "estimatedResale": "$00-$00",
      "maxBuyPrice": "$00",
      "estimatedProfit": "$00-$00",
      "confidence": "HIGH",
      "recommendation": "BUY"
    }
  ]
}

Do not include markdown or any text outside the JSON.`;
User notes: ${notes || "none"}`;

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
      const q = it.searchQuery || [it.brand,it.model,it.name].filter(Boolean).join(" ");
      try { it.activeComps = await ebayActiveComps(q); }
      catch(e) { it.activeComps = {configured:true, listings:[], median:null, error:e.message}; }
      try { it.soldComps = await soldComps(q); }
      catch(e) { it.soldComps = {configured:true, comps:[], median:null, error:e.message}; }
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
