const CONFIG = {
  supabaseUrl: process.env.supabase_url,
  supabaseAnonKey: process.env.supabase_anon_key,
  openaiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
};

const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 12000;
const MAX_TOTAL_LENGTH = 30000;

function validateMessages(messages) {
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_MESSAGES
  ) {
    throw new Error("Invalid message list.");
  }

  let total = 0;

  for (const message of messages) {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      !message.content.trim() ||
      message.content.length > MAX_MESSAGE_LENGTH
    ) {
      throw new Error("Invalid message.");
    }

    total += message.content.length;
  }

  if (total > MAX_TOTAL_LENGTH) {
    throw new Error("Message history is too large.");
  }

  return messages;
}

async function authenticateUser(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(
      `${CONFIG.supabaseUrl}/auth/v1/user`,
      {
        headers: {
          apikey: CONFIG.supabaseAnonKey,
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      }
    );

    if (!response.ok) return false;

    const user = await response.json();
    return Boolean(user?.id);
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CONFIG.openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CONFIG.model,
          input: messages.map(({ role, content }) => ({
            role,
            content: content.trim(),
          })),
          max_output_tokens: 2048,
          store: false,
        }),
        signal: controller.signal,
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error("OpenAI request failed.");
      error.status = response.status;
      throw error;
    }

    const reply = (data.output || [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text)
      .join("");

    if (!reply) {
      throw new Error("OpenAI returned no text.");
    }

    return reply;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Method not allowed.",
    });
  }

  let supabaseUrl;

  try {
    supabaseUrl = new URL(CONFIG.supabaseUrl);

    if (
      supabaseUrl.protocol !== "https:" ||
      !supabaseUrl.hostname.endsWith(".supabase.co") ||
      supabaseUrl.pathname !== "/" ||
      supabaseUrl.search ||
      supabaseUrl.hash
    ) {
      throw new Error("Invalid URL");
    }
  } catch {
    return res.status(503).json({
      error: "Supabase configuration is invalid.",
    });
  }

  if (
    !CONFIG.supabaseAnonKey ||
    !CONFIG.openaiKey ||
    !CONFIG.model
  ) {
    return res.status(503).json({
      error: "Chat service is not configured.",
    });
  }

  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);

  if (!match) {
    return res.status(401).json({
      error: "Please sign in again.",
    });
  }

  try {
    const authenticated = await authenticateUser(match[1]);

    if (!authenticated) {
      return res.status(401).json({
        error: "Your session is invalid or expired.",
      });
    }
  } catch (error) {
    return res.status(
      error.name === "AbortError" ? 504 : 503
    ).json({
      error: "Unable to verify your session. Please try again.",
    });
  }

  let messages;

  try {
    messages = validateMessages(req.body?.messages);
  } catch (error) {
    return res.status(400).json({
      error: error.message,
    });
  }

  try {
    const reply = await callOpenAI(messages);

    return res.status(200).json({
      reply,
      model: CONFIG.model,
      status: "success",
    });
  } catch (error) {
    if (error.name === "AbortError") {
      return res.status(504).json({
        error: "The AI took too long to respond. Try again.",
      });
    }

    if (error.status === 429) {
      return res.status(429).json({
        error: "API quota or rate limit reached.",
      });
    }

    if (error.status === 401 || error.status === 403) {
      return res.status(502).json({
        error: "The AI provider rejected the server API key.",
      });
    }

    if (error.status === 400) {
      return res.status(502).json({
        error: "The AI provider rejected the request or model.",
      });
    }

    return res.status(502).json({
      error: "The AI service is temporarily unavailable.",
    });
  }
}
