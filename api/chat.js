const CONFIG = {
  // These names must match the Environment Variables in Vercel.
  url: process.env.SUPABASE_URL,
  anonKey: process.env.supabase_anon_key,
  serviceKey: process.env.supabase_service_role_key,
  geminiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
};

const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 12000;
const MAX_TOTAL_LENGTH = 30000;

function sendJson(res, status, body) {
  return res.status(status).json(body);
}

function getMissingConfig() {
  const required = {
    SUPABASE_URL: CONFIG.url,
    supabase_anon_key: CONFIG.anonKey,
    supabase_service_role_key: CONFIG.serviceKey,
    GEMINI_API_KEY: CONFIG.geminiKey,
  };

  return Object.entries(required)
    .filter(([, value]) => !value || !String(value).trim())
    .map(([name]) => name);
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "messages must be a non-empty array.";
  }

  if (messages.length > MAX_MESSAGES) {
    return `A maximum of ${MAX_MESSAGES} messages is allowed.`;
  }

  let totalLength = 0;

  for (const message of messages) {
    if (
      !message ||
      typeof message !== "object" ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string"
    ) {
      return "Each message must have a valid role and string content.";
    }

    if (message.content.length > MAX_MESSAGE_LENGTH) {
      return "A message exceeds the maximum allowed length.";
    }

    totalLength += message.content.length;
  }

  if (totalLength > MAX_TOTAL_LENGTH) {
    return "The conversation exceeds the maximum allowed size.";
  }

  return null;
}

function toGeminiContents(messages) {
  // Gemini expects user/model roles and alternating conversational turns.
  const contents = [];

  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user";
    const text = message.content.trim();

    if (!text) continue;

    const last = contents[contents.length - 1];

    if (last && last.role === role) {
      last.parts[0].text += "\n\n" + text;
    } else {
      contents.push({
        role,
        parts: [{ text }],
      });
    }
  }

  // Gemini conversations must start with a user message.
  while (contents.length && contents[0].role !== "user") {
    contents.shift();
  }

  return contents;
}

async function authenticateUser(token) {
  const response = await fetch(`${CONFIG.url.replace(/\/+$/, "")}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: CONFIG.anonKey,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) return null;

  const user = await response.json();

  if (!user || typeof user.id !== "string") return null;

  return user;
}

async function callGemini(messages) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(CONFIG.model) +
    ":generateContent";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": CONFIG.geminiKey,
    },
    body: JSON.stringify({
      contents: messages,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
      },
    }),
    signal: AbortSignal.timeout(45000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error("Gemini request failed.");
    error.status = response.status;
    error.providerMessage =
      typeof data?.error?.message === "string"
        ? data.error.message
        : "The AI provider returned an error.";
    throw error;
  }

  const answer = (data.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();

  if (!answer) {
    throw new Error("The AI provider returned an empty response.");
  }

  return answer;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, {
      error: "Method not allowed. Use POST.",
    });
  }

  // Do not expose internal configuration or secrets in responses.
  const missing = getMissingConfig();

  if (missing.length > 0) {
    console.error("Chat API configuration is incomplete:", missing);

    return sendJson(res, 503, {
      error: "Server configuration incomplete.",
      missing,
      hint: "Check the Environment Variables configured for this Vercel deployment.",
    });
  }

  const token = getBearerToken(req);

  if (!token) {
    return sendJson(res, 401, {
      error: "Authentication required. Please sign in again.",
    });
  }

  let user;

  try {
    user = await authenticateUser(token);
  } catch (error) {
    console.error("Supabase authentication request failed:", error.message);

    return sendJson(res, 502, {
      error: "Could not verify your session. Please try again.",
    });
  }

  if (!user) {
    return sendJson(res, 401, {
      error: "Your session is invalid or expired. Please sign in again.",
    });
  }

  const body = req.body;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendJson(res, 400, {
      error: "A valid JSON request body is required.",
    });
  }

  const validationError = validateMessages(body.messages);

  if (validationError) {
    return sendJson(res, 400, {
      error: validationError,
    });
  }

  const contents = toGeminiContents(body.messages);

  if (
    contents.length === 0 ||
    contents[0].role !== "user"
  ) {
    return sendJson(res, 400, {
      error: "Provide at least one non-empty user message.",
    });
  }

  try {
    const reply = await callGemini(contents);

    return sendJson(res, 200, {
      reply,
      model: CONFIG.model,
      status: "success",
    });
  } catch (error) {
    console.error("Chat provider request failed:", {
      status: error.status || null,
      message: error.providerMessage || error.message,
    });

    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return sendJson(res, 504, {
        error: "The AI provider took too long to respond. Please try again.",
      });
    }

    if (error.status === 429) {
      return sendJson(res, 429, {
        error: "The AI provider's rate limit or quota has been reached.",
      });
    }

    if (error.status === 401 || error.status === 403) {
      return sendJson(res, 502, {
        error: "The AI provider rejected its server API credentials.",
      });
    }

    return sendJson(res, 502, {
      error: "The AI provider could not complete your request.",
    });
  }
};
