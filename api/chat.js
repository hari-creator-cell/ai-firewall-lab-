
const MAX_BODY_BYTES = 32 * 1024;
const MAX_PROMPT_LENGTH = 8000;
const LAB_TIMEOUT_MS = 15000;
const GEMINI_TIMEOUT_MS = 30000;

function json(res, status, data) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(data);
}

function extractText(value) {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part && typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (!value || typeof value !== "object") return "";

  for (const key of ["text", "prompt", "message", "content"]) {
    if (typeof value[key] === "string") return value[key];
  }

  if (Array.isArray(value.parts)) {
    return extractText(value.parts);
  }

  return "";
}

function getPrompt(body) {
  // Common simple chat request formats.
  const direct = extractText(body);
  if (direct.trim()) return direct.trim();

  // OpenAI-style messages array: use the latest user message.
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const item = body.messages[i];

      if (
        item &&
        typeof item === "object" &&
        (!item.role || item.role === "user")
      ) {
        const value = extractText(item);
        if (value.trim()) return value.trim();
      }
    }
  }

  // Some frontends use input or conversation arrays.
  if (typeof body.input === "string") return body.input.trim();

  if (Array.isArray(body.conversation)) {
    for (let i = body.conversation.length - 1; i >= 0; i--) {
      const value = extractText(body.conversation[i]);
      if (value.trim()) return value.trim();
    }
  }

  return "";
}

function getDecision(result) {
  const raw = result?.decision ?? result?.verdict ?? result?.status;

  if (typeof raw !== "string") return null;

  const value = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");

  if (["ALLOW", "ALLOWED", "APPROVE", "APPROVED"].includes(value)) {
    return "ALLOW";
  }

  if (["DENY", "DENIED", "BLOCK", "BLOCKED", "REJECTED"].includes(value)) {
    return "DENY";
  }

  return null;
}

async function fetchTimed(url, options, timeoutMs) {
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

  const prompt = getPrompt(body);

  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
    return json(res, 400, {
      error: "Provide a prompt of 1–8000 characters.",
      code: "INVALID_PROMPT",
    });
  }

  const labBase = process.env.LAB_URL?.trim()?.replace(/\/+$/, "");
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim();

  if (!labBase || !apiKey || !model) {
    console.error("Chat configuration missing:", {
      labUrl: !labBase,
      geminiApiKey: !apiKey,
      geminiModel: !model,
    });

    return json(res, 503, {
      error: "Chat service configuration is incomplete.",
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

  const requestId = crypto.randomUUID();
  let inspection;

  // Inspect with the firewall BEFORE calling Gemini.
  try {
    const response = await fetchTimed(
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
      LAB_TIMEOUT_MS
    );

    if (!response.ok) {
      console.error("Lab inspection returned non-success status:", {
        status: response.status,
        requestId,
      });

      return json(res, 503, {
        error: "AI Firewall Lab is unavailable. No result was fabricated.",
        code: "FIREWALL_UNAVAILABLE",
        requestId,
      });
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("Lab returned a non-JSON response");
    }

    inspection = await response.json();
  } catch (error) {
    console.error("Lab inspection failed:", {
      requestId,
      errorName: error?.name || "Error",
    });

    return json(res, 503, {
      error: "AI Firewall Lab is unavailable. No result was fabricated.",
      code: "FIREWALL_UNAVAILABLE",
      requestId,
    });
  }

  const decision = getDecision(inspection);

  // Unknown or missing decisions are never treated as permission.
  if (decision !== "ALLOW") {
    return json(res, decision === "DENY" ? 403 : 503, {
      error:
        decision === "DENY"
          ? "The AI Firewall Lab denied this request."
          : "The Lab returned no recognized authorization verdict.",
      code:
        decision === "DENY"
          ? "FIREWALL_DENIED"
          : "INVALID_FIREWALL_VERDICT",
      requestId,
      firewall: {
        decision: decision || "UNKNOWN",
      },
    });
  }

  // Call Gemini only after the explicit firewall allow verdict.
  let response;

  try {
    response = await fetchTimed(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
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
      GEMINI_TIMEOUT_MS
    );
  } catch (error) {
    console.error("Gemini request failed:", {
      requestId,
      errorName: error?.name || "Error",
    });

    return json(res, 502, {
      error: "The AI provider could not complete the request.",
      code: "AI_PROVIDER_UNAVAILABLE",
      requestId,
    });
  }

  if (!response.ok) {
    console.error("Gemini returned non-success status:", {
      status: response.status,
      model,
      requestId,
    });

    return json(
      res,
      response.status === 429 || response.status >= 500 ? 503 : 502,
      {
        error: "The AI provider could not complete the request.",
        code: "AI_PROVIDER_ERROR",
        requestId,
      }
    );
  }

  let generated;

  try {
    generated = await response.json();
  } catch {
    return json(res, 502, {
      error: "The AI provider returned invalid JSON.",
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
