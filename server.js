// Express server for Railway: webhook receiver for monday.com.
// Exposes:
// - GET /health -> { ok: true }
// - POST /webhook
// - POST /monday-webhook
// - POST /.netlify/functions/monday-webhook
//
// All POST endpoints delegate to the existing Netlify Function handler without
// changing the business logic.

const express = require("express");
const { handler } = require("./netlify/functions/monday-webhook.js");

const app = express();

// Capture raw body so we can pass a JSON string to the Netlify handler.
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf ? buf.toString("utf8") : "";
    },
  })
);

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

async function delegateToNetlifyHandler(req, res) {
  try {
    // monday expects exact challenge echo; handler already does this if body parses.
    const bodyString =
      typeof req.rawBody === "string" && req.rawBody.trim() ? req.rawBody : JSON.stringify(req.body ?? {});

    const event = {
      httpMethod: "POST",
      headers: req.headers || {},
      body: bodyString,
      isBase64Encoded: false,
    };

    const fnResponse = await handler(event);
    const statusCode = fnResponse?.statusCode ?? 200;
    const headers = fnResponse?.headers ?? { "Content-Type": "application/json; charset=utf-8" };
    const body = fnResponse?.body ?? "";

    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    res.status(statusCode).send(body);
  } catch (err) {
    console.error("server error", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
}

app.post("/webhook", delegateToNetlifyHandler);
app.post("/monday-webhook", delegateToNetlifyHandler);
app.post("/.netlify/functions/monday-webhook", delegateToNetlifyHandler);

// Basic 404 JSON to help debug Railway routing issues.
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});

