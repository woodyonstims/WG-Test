import express from "express";
import { google } from "googleapis";
import Twilio from "twilio";
import Redis from "ioredis";

// --- CONFIG ---
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const redis = process.env.SESSION_STORE === "redis" ? new Redis(process.env.REDIS_URL) : null;
const twilio = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_FROM;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// --- GOOGLE SHEETS SETUP (secret-file method) ---
let _sheetsClient = null;

async function sheets() {
  if (_sheetsClient) return _sheetsClient;

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS not set");
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, // e.g. /etc/secrets/creds.json
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const client = await auth.getClient();
  _sheetsClient = google.sheets({ version: "v4", auth: client });
  return _sheetsClient;
}

// --- READ QUESTIONS ---
async function readQuestions() {
  const s = await sheets();
  const { data } = await s.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Questions!A2:H",
  });

  return (data.values || []).map((r) => ({
    id: r[0],
    section: r[1],
    stem: r[2],
    passage: r[3],
    options: JSON.parse(r[4]),
    correct: Number(r[5]),
    rationale: r[6],
    difficulty: r[7] || "M",
  }));
}

// --- SESSION HELPERS (with in-memory fallback) ---
const memStore = new Map();

function memGet(key) {
  const rec = memStore.get(key);
  if (!rec) return null;
  if (rec.expires && Date.now() > rec.expires) {
    memStore.delete(key);
    return null;
  }
  return rec.value;
}

function memSet(key, val, ttl = 3600) {
  memStore.set(key, { value: val, expires: Date.now() + ttl * 1000 });
}

async function getSession(key) {
  if (redis) {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } else {
    return memGet(key);
  }
}

async function setSession(key, val, ttl = 3600) {
  if (redis) {
    await redis.set(key, JSON.stringify(val), "EX", ttl);
  } else {
    memSet(key, val, ttl);
  }
}

// --- QUESTION LOGIC ---
const SECTIONS = ["Inference", "Assumptions", "Deduction", "Interpretation", "Arguments"];

function pickNextQuestion(qs, section, askedIds) {
  const pool = qs.filter((q) => q.section === section && !askedIds.has(q.id));
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// --- MAIN WEBHOOK HANDLER ---
app.post("/whatsapp/webhook", async (req, res) => {
  const from = req.body.From || req.body.from; // WhatsApp user number
  const body = (req.body.Body || "").trim();
  const userId = from;

  let session = (await getSession(userId)) || {
    state: "IDLE",
    sectionIndex: 0,
    asked: [],
    answers: [],
    qStart: Date.now(),
  };

  const questions = await readQuestions();

  // Start test
  if (session.state === "IDLE" && /^start|test$/i.test(body)) {
    session.state = "ASKING";
    session.sectionIndex = 0;
    session.answers = [];
    await sendWA(
      from,
      "✅ Watson-Glaser test started.\nYou’ll get one question per section.\nReply with the number of your chosen option."
    );
  }

  // Record answer
  if (session.state === "WAITING_ANSWER") {
    const num = parseInt(body, 10);
    const q = session.currentQ;

    if (!q || Number.isNaN(num) || num < 1 || num > q.options.length) {
      await sendWA(from, `Please reply with a number 1–${q.options.length}.`);
      return res.sendStatus(200);
    }

    const latency = Date.now() - session.qStart;
    const isCorrect = num === q.correct;
    session.answers.push({
      qid: q.id,
      section: q.section,
      selected: num,
      correct: q.correct,
      isCorrect,
      latency,
    });

    appendAttempt({
      attempt_id: `${userId}-${q.id}-${Date.now()}`,
      user_id: userId,
      qid: q.id,
      section: q.section,
      selected: num,
      correct: q.correct,
      is_correct: isCorrect,
      latency_ms: latency,
    }).catch(() => {});

    session.state = "ASKING";
    session.currentQ = null;
  }

  // Ask next question
  if (session.state === "ASKING") {
    if (session.sectionIndex >= SECTIONS.length) {
      // --- SCORING ---
      const bySection = {};
      for (const a of session.answers) {
        bySection[a.section] ??= { total: 0, correct: 0, wrongIds: [] };
        bySection[a.section].total++;
        if (a.isCorrect) bySection[a.section].correct++;
        else bySection[a.section].wrongIds.push(a.qid);
      }

      let totalCorrect = 0,
        total = 0;
      for (const s of SECTIONS) {
        const m = bySection[s];
        if (!m) continue;
        totalCorrect += m.correct;
        total += m.total;
      }
      const pct = total ? Math.round((100 * totalCorrect) / total) : 0;

      const rationaleLines = [];
      for (const s of SECTIONS) {
        const m = bySection[s];
        if (!m || m.wrongIds.length === 0) continue;
        const qWrong = questions.find((q) => q.id === m.wrongIds[0]);
        if (qWrong?.rationale)
          rationaleLines.push(`• ${s}: ${qWrong.rationale}`);
      }

      const summary =
        rationaleLines.length > 0
          ? `\n\nFeedback:\n${rationaleLines.join("\n")}`
          : "";

      await sendWA(
        from,
        `✅ Test complete!\nScore: ${totalCorrect}/${total} (${pct}%)${summary}`
      );

      session.state = "IDLE";
      await setSession(userId, session);
      return res.sendStatus(200);
    }

    const section = SECTIONS[session.sectionIndex];
    const askedIds = new Set(
      session.answers.filter((a) => a.section === section).map((a) => a.qid)
    );
    const q = pickNextQuestion(questions, section, askedIds);

    if (!q) {
      session.sectionIndex++;
      await setSession(userId, session);
      await sendWA(from, `Skipping ${section} (no questions available).`);
      return res.sendStatus(200);
    }

    const head = `🧠 Section: ${section}`;
    const passage = q.passage ? `\n\nPassage:\n${q.passage}` : "";
    const options = q.options.map((o, i) => `${i + 1}) ${o}`).join("\n");

    await sendWA(
      from,
      `${head}${passage}\n\nQuestion:\n${q.stem}\n\n${options}\n\nReply with 1–${q.options.length}.`
    );

    session.currentQ = q;
    session.qStart = Date.now();
    session.state = "WAITING_ANSWER";
    session.sectionIndex++;
  }

  await setSession(userId, session);
  res.sendStatus(200);
});

// --- BASIC ROUTE ---
app.get("/", (req, res) => res.send("Watson-Glaser WhatsApp Bot is running!"));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));


