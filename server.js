import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import pg from "pg";

const app = express();
const port = process.env.PORT || 8080;
const root = path.dirname(fileURLToPath(import.meta.url));
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

app.set("trust proxy", 1);
app.use(cookieParser());

async function prepareDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_visitors (
      visit_date DATE NOT NULL,
      visitor_id UUID NOT NULL,
      views INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (visit_date, visitor_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_taksit_visitors (
      visit_date DATE NOT NULL,
      visitor_id UUID NOT NULL,
      views INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (visit_date, visitor_id)
    )
  `);
}

async function recordVisit(visitorId, table = "daily_visitors") {
  if (!pool) return;
  const safeTable = table === "daily_taksit_visitors" ? "daily_taksit_visitors" : "daily_visitors";
  await pool.query(
    `INSERT INTO ${safeTable} (visit_date, visitor_id, views)
     VALUES ((NOW() AT TIME ZONE 'Europe/Istanbul')::date, $1, 1)
     ON CONFLICT (visit_date, visitor_id)
     DO UPDATE SET views = ${safeTable}.views + 1`,
    [visitorId],
  );
}

app.get("/", async (req, res) => {
  let visitorId = req.cookies.hys_visitor;

  if (!visitorId || !/^[0-9a-f-]{36}$/i.test(visitorId)) {
    visitorId = crypto.randomUUID();
    res.cookie("hys_visitor", visitorId, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    });
  }

  try {
    await recordVisit(visitorId);
  } catch (error) {
    console.error("Ziyaret kaydedilemedi:", error.message);
  }

  res.sendFile(path.join(root, "index.html"));
});

async function sendCounter(res, table = "daily_visitors") {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL tanımlı değil." });
  }

  try {
    const safeTable = table === "daily_taksit_visitors" ? "daily_taksit_visitors" : "daily_visitors";
    const { rows } = await pool.query(`
      WITH days AS (
        SELECT generate_series(
          (NOW() AT TIME ZONE 'Europe/Istanbul')::date - 6,
          (NOW() AT TIME ZONE 'Europe/Istanbul')::date,
          INTERVAL '1 day'
        )::date AS visit_date
      )
      SELECT
        TO_CHAR(days.visit_date, 'YYYY-MM-DD') AS date,
        COALESCE(SUM(${safeTable}.views), 0)::int AS total,
        COUNT(${safeTable}.visitor_id)::int AS unique_visitors
      FROM days
      LEFT JOIN ${safeTable} USING (visit_date)
      GROUP BY days.visit_date
      ORDER BY days.visit_date DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error("Sayaç okunamadı:", error.message);
    res.status(500).json({ error: "Sayaç verileri alınamadı." });
  }
}

app.get("/api/sayac", async (_req, res) => {
  await sendCounter(res);
});

app.get("/api/taksit-sayac", async (_req, res) => {
  await sendCounter(res, "daily_taksit_visitors");
});

app.get("/sayac", (_req, res) => {
  res.sendFile(path.join(root, "sayac.html"));
});

app.get("/taksit", async (req, res) => {
  let visitorId = req.cookies.hys_visitor;
  if (!visitorId || !/^[0-9a-f-]{36}$/i.test(visitorId)) {
    visitorId = crypto.randomUUID();
    res.cookie("hys_visitor", visitorId, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    });
  }
  try {
    await recordVisit(visitorId, "daily_taksit_visitors");
  } catch (error) {
    console.error("Taksit ziyareti kaydedilemedi:", error.message);
  }
  res.sendFile(path.join(root, "taksit.html"));
});

app.get("/taksit/sayac", (_req, res) => {
  res.sendFile(path.join(root, "sayac.html"));
});

app.get("/health", (_req, res) => res.send("ok"));

prepareDatabase()
  .then(() => app.listen(port, "0.0.0.0", () => console.log(`Sunucu ${port} portunda çalışıyor.`)))
  .catch((error) => {
    console.error("Veritabanı hazırlanamadı:", error);
    process.exit(1);
  });
