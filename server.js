const express = require("express");
const twilio = require("twilio");
const admin = require("firebase-admin");
const OpenAI = require("openai");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const COLLECTION = process.env.FIRESTORE_COLLECTION || "calls";

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- Firebase ----------
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("Missing FIREBASE_SERVICE_ACCOUNT environment variable");
  } else {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
}

const db = admin.firestore();

// ---------- OpenAI ----------
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ---------- Helpers ----------
function safeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function maskPhone(phone) {
  const p = safeText(phone);
  if (p.length < 5) return p;
  return `${p.slice(0, 6)}*****${p.slice(-2)}`;
}

function normalizeUrl(url) {
  const u = safeText(url);
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return `https://${u}`;
}

function xmlSay(twiml, message) {
  twiml.say(
    {
      language: "fi-FI",
    },
    message
  );
}

const defaultSettings = {
  mode: "business",
  activeReply: "reply1",
  company: {
    name: "Linjo Business -yritys",
    websiteUrl: "",
    tone: "selkeä, ystävällinen ja ammattimainen",
    fallbackInstruction:
      "Jos et tiedä vastausta varmasti, älä keksi. Pyydä soittajaa jättämään nimi ja asia, ja kerro että yritys palaa asiaan.",
    opening:
      "Hei, olet yhteydessä yrityksen tekoälyavustajaan. Miten voin auttaa?",
    closing:
      "Kiitos soitosta. Välitän asian tarvittaessa eteenpäin. Hei hei.",
  },
  businessInfo: {
    openingHours: "",
    address: "",
    services: "",
    prices: "",
    bookingInstructions: "",
    faq: "",
    websiteKnowledge: "",
  },
  replies: {
    reply1: {
      name: "Yleinen asiakaspalvelu",
      message:
        "Hei, olet yhteydessä yrityksen tekoälyavustajaan. Kerro lyhyesti, miten voin auttaa.",
    },
    reply2: {
      name: "Kiireinen hetki",
      message:
        "Hei, yrityksessä on juuri kiireinen hetki. Kerro lyhyesti nimesi ja asiasi, niin välitän viestin eteenpäin.",
    },
    reply3: {
      name: "Suljettu",
      message:
        "Hei, yritys on tällä hetkellä suljettu. Kerro nimesi ja asiasi, niin välitän viestin eteenpäin.",
    },
  },
};

async function getSettings() {
  const ref = db.collection("settings").doc("business");
  const doc = await ref.get();

  if (!doc.exists) return defaultSettings;

  const data = doc.data();

  return {
    ...defaultSettings,
    ...data,
    company: {
      ...defaultSettings.company,
      ...(data.company || {}),
    },
    businessInfo: {
      ...defaultSettings.businessInfo,
      ...(data.businessInfo || {}),
    },
    replies: {
      ...defaultSettings.replies,
      ...(data.replies || {}),
    },
  };
}

async function saveSettings(payload) {
  const clean = {
    mode: "business",
    activeReply: payload.activeReply || "reply1",
    company: payload.company || {},
    businessInfo: payload.businessInfo || {},
    replies: payload.replies || {},
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection("settings").doc("business").set(clean, { merge: true });
}

async function getActiveGreeting() {
  const settings = await getSettings();
  const active = settings.activeReply || "reply1";
  const reply = settings.replies?.[active];
  return reply?.message || settings.company.opening || defaultSettings.company.opening;
}

function buildKnowledge(settings) {
  const c = settings.company || {};
  const b = settings.businessInfo || {};
  return `
YRITYKSEN NIMI:
${c.name || ""}

VERKKOSIVU:
${c.websiteUrl || ""}

SÄVY:
${c.tone || ""}

AUKIOLOAJAT:
${b.openingHours || ""}

OSOITE:
${b.address || ""}

PALVELUT:
${b.services || ""}

HINNAT:
${b.prices || ""}

AJANVARAUSOHJEET:
${b.bookingInstructions || ""}

USEIN KYSYTYT KYSYMYKSET:
${b.faq || ""}

VERKKOSIVULTA HAETTU TIETO:
${b.websiteKnowledge || ""}

TOIMINTAOHJE EPÄSELVÄSSÄ TILANTEESSA:
${c.fallbackInstruction || ""}
`.trim();
}

async function analyzeBusinessCall(speechText, settings) {
  const fallback = {
    category: "Epäselvä",
    priority: "keskitaso",
    summary: speechText || "Ei puhesisältöä",
    recommendedAction: "Tarkista puhelu",
    spamRisk: 10,
    riskReason: "Ei tarkempaa analyysiä",
    assistantAnswer:
      "Kiitos. Välitän viestin yritykselle. He palaavat asiaan tarvittaessa.",
  };

  if (!openai || !speechText) return fallback;

  const knowledge = buildKnowledge(settings);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `
Olet Linjo Business -puhelinassistentti yritykselle.
Vastaa soittajalle vain yrityksen tietopankin perusteella.
Älä keksi tietoja. Jos et tiedä varmasti, pyydä yhteystiedot ja kerro että asia välitetään yritykselle.
Analysoi myös puhelun tarkoitus.

Palauta VAIN validi JSON:
{
  "category": "...",
  "priority": "matala|keskitaso|korkea",
  "summary": "...",
  "recommendedAction": "...",
  "spamRisk": 0,
  "riskReason": "...",
  "assistantAnswer": "..."
}

Yrityksen tietopankki:
${knowledge}
`.trim(),
        },
        {
          role: "user",
          content: speechText,
        },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    return { ...fallback, ...JSON.parse(cleaned) };
  } catch (error) {
    console.error("OpenAI business analysis failed:", error);
    return fallback;
  }
}

async function scrapeWebsiteText(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) throw new Error("Website URL is required");

  const response = await fetch(normalized, {
    headers: {
      "User-Agent": "LinjoBusinessBot/1.0 (+https://linjo.example)",
    },
  });

  if (!response.ok) {
    throw new Error(`Website fetch failed: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  $("script, style, noscript, svg, img, video, iframe").remove();

  const title = $("title").first().text();
  const metaDescription = $('meta[name="description"]').attr("content") || "";

  const headings = $("h1,h2,h3")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean)
    .slice(0, 40)
    .join("\n");

  const bodyText = $("body")
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);

  return `
Sivun otsikko: ${title}
Metakuvaus: ${metaDescription}

Otsikot:
${headings}

Sivun tekstisisältö:
${bodyText}
`.trim();
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.send("Linjo Business backend toimii ✅");
});

app.get("/dashboard", (req, res) => {
  res.sendFile(__dirname + "/dashboard-business.html");
});

app.get("/api/calls", async (req, res) => {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const calls = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(calls);
  } catch (error) {
    console.error("Calls fetch failed:", error);
    res.status(500).json({ error: "Puheluiden haku epäonnistui" });
  }
});

app.get("/api/settings", async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (error) {
    console.error("Settings fetch failed:", error);
    res.status(500).json({ error: "Asetusten haku epäonnistui" });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    await saveSettings(req.body || {});
    res.json({ ok: true });
  } catch (error) {
    console.error("Settings save failed:", error);
    res.status(500).json({ error: "Asetusten tallennus epäonnistui" });
  }
});

app.post("/api/scrape-website", async (req, res) => {
  try {
    const { websiteUrl } = req.body || {};
    const text = await scrapeWebsiteText(websiteUrl);

    const current = await getSettings();
    const nextBusinessInfo = {
      ...(current.businessInfo || {}),
      websiteKnowledge: text,
    };

    const nextCompany = {
      ...(current.company || {}),
      websiteUrl: normalizeUrl(websiteUrl),
    };

    await saveSettings({
      ...current,
      company: nextCompany,
      businessInfo: nextBusinessInfo,
    });

    res.json({ ok: true, websiteKnowledge: text });
  } catch (error) {
    console.error("Website scrape failed:", error);
    res.status(500).json({
      error: "Verkkosivun tietojen haku epäonnistui",
      details: error.message,
    });
  }
});

// Twilio Voice webhook
app.post("/voice", async (req, res) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();
    const greeting = await getActiveGreeting();

    const gather = twiml.gather({
      input: "speech",
      action: "/process-speech",
      method: "POST",
      language: "fi-FI",
      speechTimeout: "auto",
      timeout: 7,
    });

    xmlSay(gather, greeting);

    xmlSay(
      twiml,
      "En kuullut vastausta. Voit soittaa myöhemmin uudelleen. Hei hei."
    );

    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("Voice route failed:", error);
    const twiml = new twilio.twiml.VoiceResponse();
    xmlSay(twiml, "Puhelinavustajassa tapahtui virhe. Yritä myöhemmin uudelleen.");
    res.type("text/xml").send(twiml.toString());
  }
});

// Twilio speech processing
app.post("/process-speech", async (req, res) => {
  try {
    const speechText = safeText(req.body.SpeechResult);
    const from = safeText(req.body.From, "Tuntematon");
    const callSid = safeText(req.body.CallSid);

    const settings = await getSettings();
    const ai = await analyzeBusinessCall(speechText, settings);

    await db.collection(COLLECTION).add({
      mode: "business",
      companyName: settings.company?.name || "",
      from,
      fromMasked: maskPhone(from),
      callerNumber: from,
      callSid,
      transcript: speechText,
      speechText,
      category: ai.category || "Epäselvä",
      priority: ai.priority || "keskitaso",
      summary: ai.summary || speechText || "Ei yhteenvetoa",
      recommendedAction: ai.recommendedAction || "Tarkista puhelu",
      spamRisk: Number(ai.spamRisk ?? 10),
      riskReason: ai.riskReason || "Ei riskiselitettä",
      assistantAnswer: ai.assistantAnswer || "",
      status: "new",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const twiml = new twilio.twiml.VoiceResponse();

    xmlSay(
      twiml,
      ai.assistantAnswer ||
        settings.company?.closing ||
        "Kiitos. Välitän asian eteenpäin. Hei hei."
    );

    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("Speech processing failed:", error);
    const twiml = new twilio.twiml.VoiceResponse();
    xmlSay(twiml, "Kiitos soitosta. Viestin käsittelyssä tapahtui virhe.");
    res.type("text/xml").send(twiml.toString());
  }
});

app.listen(PORT, () => {
  console.log(`Linjo Business server running on port ${PORT}`);
});
