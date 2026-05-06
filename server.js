// Minimal HTTP server for Railway (no frameworks).
// Exposes:
// - GET /health -> { ok: true }
// - POST /webhook -> delegates to existing Netlify function handler

const http = require("http");
const { handler } = require("./netlify/functions/monday-webhook.js");

function sendJson(res, statusCode, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const url = req.url || "/";

    if (method === "GET" && url === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/webhook") {
      const rawBody = await readRequestBody(req);

      // Map standard HTTP request to Netlify Function event shape
      const event = {
        httpMethod: "POST",
        headers: req.headers || {},
        body: rawBody || "",
        isBase64Encoded: false,
      };

      const fnResponse = await handler(event);
      const statusCode = fnResponse?.statusCode ?? 200;
      const headers = fnResponse?.headers ?? { "Content-Type": "application/json; charset=utf-8" };
      const body = fnResponse?.body ?? "";

      res.writeHead(statusCode, headers);
      res.end(body);
      return;
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    console.error("server error", err);
    return sendJson(res, 500, { ok: false, error: "Internal server error" });
  }
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});

