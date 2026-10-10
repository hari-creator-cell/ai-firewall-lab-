
const CONFIG = {
  supabaseUrl: process.env.supabase_url,
  supabaseAnonKey: process.env.supabase_anon_key,
  firewallUrl:
    "https://ai-firewall-lab-hackathon.vercel.app/api/inspect",
};

const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 12000;
const MAX_TOTAL_LENGTH = 30000;
const FIREWALL_MAX_CHARS = 12000;
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Validate chat history received from the frontend.
 */
function validateMessages(messages) {
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_MESSAGES
  ) {
    throw new Error("Invalid message list.");
  }

  let totalLength = 0;

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

    totalLength += message.content.length;
  }

  if (totalLength > MAX_TOTAL_LENGTH) {
    throw new Error("Message history is too large.");
  }

  return messages;
}

/**
 * Verify the user's Supabase access token.
 */
async function authenticateUser(token) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `${CONFIG.supabaseUrl}/auth/v1/user`,
      {
        method: "GET",
        headers: {
          apikey: CONFIG.supabaseAnonKey,
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      return false;
    }

    const user = await response.json();

    return Boolean(user && user.id);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send a prompt to AI Firewall Lab.
 * No AI provider or tool executor is called here.
 */
async function inspectPrompt(prompt) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(CONFIG.firewallUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        text: prompt,
      }),
      signal: controller.signal,
    });

    const result = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error("Firewall request failed.");
    }

    if (
      !result ||
      !["ALLOW", "REVIEW", "BLOCK"].includes(result.decision) ||
      typeof result.score !== "number" ||
      !Array.isArray(result.reasons)
    ) {
      throw new Error("Invalid firewall response.");
    }

    return {
      decision: result.decision,
      score: result.score,
      reasons: result.reasons.filter(
        (reason) => typeof reason === "string"
      ),
      source: result.source || "AI Firewall Lab",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Vercel serverless API endpoint.
 */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Method not allowed.",
    });
  }

  // Check server configuration.
  let supabaseUrl;

  try {
    if (
      !CONFIG.supabaseUrl ||
      !CONFIG.supabaseAnonKey
    ) {
      throw new Error("Missing configuration.");
    }

    supabaseUrl = new URL(CONFIG.supabaseUrl);

    if (
      supabaseUrl.protocol !== "https:" ||
      !supabaseUrl.hostname.endsWith(".supabase.co") ||
      supabaseUrl.pathname !== "/" ||
      supabaseUrl.search ||
      supabaseUrl.hash
    ) {
      throw new Error("Invalid Supabase URL.");
    }
  } catch {
    return res.status(503).json({
      error: "Authentication configuration is invalid.",
    });
  }

  // Require an authenticated user.
  const authorization = req.headers.authorization || "";
  const tokenMatch = authorization.match(
    /^Bearer\s+(\S+)$/i
  );

  if (!tokenMatch) {
    return res.status(401).json({
      error: "Please sign in to test prompts.",
    });
  }

  try {
    const authenticated = await authenticateUser(
      tokenMatch[1]
    );

    if (!authenticated) {
      return res.status(401).json({
        error: "Your session is invalid or expired.",
      });
    }
  } catch (error) {
    return res
      .status(error.name === "AbortError" ? 504 : 503)
      .json({
        error: "Unable to verify your session.",
      });
  }

  // Validate the incoming request.
  let messages;

  try {
    messages = validateMessages(req.body?.messages);
  } catch (error) {
    return res.status(400).json({
      error: error.message,
    });
  }

  // Test only the latest user-submitted prompt.
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  if (!latestUserMessage) {
    return res.status(400).json({
      error: "Enter a prompt to test.",
    });
  }

  const prompt = latestUserMessage.content.trim();

  if (prompt.length > FIREWALL_MAX_CHARS) {
    return res.status(400).json({
      error: "Prompts must be 12,000 characters or fewer.",
    });
  }

  // Send the prompt to the real firewall endpoint.
  let security;

  try {
    security = await inspectPrompt(prompt);
  } catch (error) {
    const timedOut = error.name === "AbortError";

    return res
      .status(timedOut ? 504 : 503)
      .json({
        status: "unavailable",
        error: timedOut
          ? "Firewall inspection timed out. Please retry."
          : "AI Firewall Lab is unavailable. No result was fabricated.",
        security: {
          decision: "UNAVAILABLE",
          source: "AI Firewall Lab",
          modelCalled: false,
          actionExecuted: false,
        },
      });
  }

  // Build dashboard data using the lab's actual response.
  const reasons = security.reasons;

  const details = reasons.length
    ? reasons.join("; ")
    : "No rule matches were reported by the lab.";

  const dashboardResult = {
    decision: security.decision,
    score: security.score,
    reasons,
    source: security.source,
    modelCalled: false,
    actionExecuted: false,
  };

  // Return the result. No model or executor is invoked.
  return res.status(200).json({
    status: "tested",
    security: dashboardResult,
    reply: [
      `Firewall verdict: ${security.decision}`,
      `Risk score: ${security.score}/100`,
      `Inspected by: ${security.source}`,
      "AI model called: No",
      "Real action executed: No",
      "",
      `Matched rules / details: ${details}`,
    ].join("\n"),
  });
}
