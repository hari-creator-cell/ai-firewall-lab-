
const MAX_BODY_BYTES = 32 * 1024;
const MAX_PROMPT_LENGTH = 8000;
const REQUEST_TIMEOUT_MS = 15000;

const json = (res, status, data) => {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.json(data);
};

function getText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const key of ["text", "prompt", "message", "content"]) {
      if (typeof value[key] === "string") return value[key];
    }
  }
  return "";
}

function normalizeDecision(result) {
  const raw = result?.decision ?? result?.verdict ?? result?.status;
  if (typeof raw !== "string") return null;

  const value = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");

  if (["ALLOW", "ALLOWED", "APPROVE", "APPROVED"].includes(value)) {
    return "ALLOW";
  }

  if (
    ["DENY", "DENIED", "BLOCK", "BLOCKED", "REJECT", "REJECTED"].includes(value)
  ) {
    return "DENY";
  }

  return null;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed." });
  }

  const labBase = process.env.LAB_URL?.trim()?.replace(/\/+$/, "");
  const geminiKey = process.env.GEMINI_API_KEY?.trim();

  // Never accept a client-provided URL for the firewall or AI provider.
  if (!labBase || !geminiKey) {
    console.error("Chat configuration missing:", {
      labUrl: !labBase,
      geminiKey: !geminiKey,
    });

    return json(res, 503, {
      error: "Chat service is not configured.",
      code: "CONFIGURATION_ERROR",
    });
  }

  let labUrl;

  try {
    labUrl = new URL(labBase);

    if (
      labUrl.protocol !== "https:" ||
      labUrl.username ||
      labUrl.password ||
      labUrl.search ||
      labUrl.hash
    ) {
      throw new Error("Invalid Lab URL");
    }
  } catch {
    return json(res, 503, {
      error: "Firewall configuration is invalid.",
      code: "FIREWALL_CONFIGURATION_ERROR",
    });
  }

  // Limit payload size before parsing.
  const declaredLength = Number(req.headers["content-length"] || 0);

  if (declaredLength > MAX_BODY_BYTES) {
    return json(res, 413, { error: "Request is too large." });
  }

  let body = req.body;

  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return json(res, 413, { error: "Request is too large." });
    }

    try {
      body = JSON.parse(body);
    } catch {
      return json(res, 400, { error: "Invalid JSON." });
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(res, 400, { error: "Invalid request body." });
  }

  const prompt = getText(body).trim();

  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
    return json(res, 400, {
      error: "Provide a prompt of 1–8000 characters.",
    });
  }

  // Ignore client-supplied decisions, trust labels, and destination URLs.
  const requestId = crypto.randomUUID();

  let inspection;

  try {
    const labResponse = await fetchWithTimeout(
      new URL("/api/inspect", labUrl).toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          text: prompt,
          requestId,
          sourceApp: "Nova AI",
        }),
      },
      REQUEST_TIMEOUT_MS
    );

    if (!labResponse.ok) {
      console.error("Firewall inspection failed:", {
        status: labResponse.status,
        requestId,
      });

      return json(res, 503, {
        error: "AI Firewall Lab is unavailable. No result was fabricated.",
        code: "FIREWALL_UNAVAILABLE",
        requestId,
      });
    }

    const contentType = labResponse.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      throw new Error("Unexpected firewall response type");
    }

    inspection = await labResponse.json();
  } catch (error) {
    console.error("Firewall inspection error:", {
      requestId,
      name: error?.name || "Error",
    });

    return json(res, 503, {
      error: "AI Firewall Lab is unavailable. No result was fabricated.",
      code: "FIREWALL_UNAVAILABLE",
      requestId,
    });
  }

  const decision = normalizeDecision(inspection);

  // Fail closed: an unknown or missing verdict never permits an AI call.
  if (decision !== "ALLOW") {
    return json(res, decision === "DENY" ? 403 : 503, {
      error:
        decision === "DENY"
          ? "The AI Firewall Lab denied this request."
          : "The firewall returned no recognized authorization verdict.",
      code:
        decision === "DENY"
          ? "FIREWALL_DENIED"
          : "INVALID_FIREWALL_VERDICT",
      requestId,
      firewall: {
        decision: decision || "UNKNOWN",
        riskScore:
          Number.isFinite(inspection?.riskScore)
            ? inspection.riskScore
            : undefined,
      },
    });
  }

  // Configure a currently supported Gemini model in Vercel.
  // Do not hard-code a model ID that may be unavailable to your account.
  const model = (process.env.GEMINI_MODEL || "").trim();

  if (!model || !/^[a-zA-Z0-9._-]+$/.test(model)) {
    return json(res, 503, {
      error: "Gemini model configuration is missing or invalid.",
      code: "MODEL_CONFIGURATION_ERROR",
      requestId,
    });
  }

  let geminiResponse;

  try {
    geminiResponse = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            maxOutputTokens: 1200,
            temperature: 0.7,
          },
        }),
      },
      30000
    );
  } catch (error) {
    console.error("Gemini request failed:", {
      requestId,
      name: error?.name || "Error",
    });

    return json(res, 502, {
      error: "The AI provider could not complete the request.",
      code: "AI_PROVIDER_UNAVAILABLE",
      requestId,
    });
  }

  if (!geminiResponse.ok) {
    // Avoid logging API keys or raw provider response bodies.
    console.error("Gemini returned an error:", {
      requestId,
      status: geminiResponse.status,
      model,
    });

    return json(
      res,
      geminiResponse.status === 429 || geminiResponse.status >= 500
        ? 503
        : 502,
      {
        error: "The AI provider could not complete the request.",
        code: "AI_PROVIDER_ERROR",
        requestId,
      }
    );
  }

  let generated;

  try {
    generated = await geminiResponse.json();
  } catch {
    return json(res, 502, {
      error: "The AI provider returned an invalid response.",
      code: "INVALID_AI_RESPONSE",
      requestId,
    });
  }

  const reply = generated?.candidates?.[0]?.content?.parts
    ?.map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();

  if (!reply) {
    return json(res, 502, {
      error: "The AI provider returned no text response.",
      code: "EMPTY_AI_RESPONSE",
      requestId,
    });
  }

  return json(res, 200, {
    reply,
    requestId,
    firewall: {
      decision: "ALLOW",
      inspected: true,
    },
  });
}
