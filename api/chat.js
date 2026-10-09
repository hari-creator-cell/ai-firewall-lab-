const crypto = require("node:crypto");

const CONFIG = {
  url: process.env.supabase_url,
  anonKey: process.env.supabase_anon_key,
  serviceKey: process.env.supabase_service_role_key,
  geminiKey: process.env.gemini_api_key,
  model: process.env.gemini_model || "gemini-2.5-flash",
};

function send(res, status, data) {
  return res.status(status).json(data);
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${CONFIG.url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: CONFIG.serviceKey,
      Authorization: `Bearer ${CONFIG.serviceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(10000),
  });

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Invalid database response");
  }

  if (!response.ok) {
    throw new Error(`Database operation failed: ${response.status}`);
  }

  return data;
}

async function writeAudit({
  userId,
  requestId,
  prompt,
  verdict,
  status,
  reason,
}) {
  const promptHash = crypto
    .createHash("sha256")
    .update(prompt)
    .digest("hex");

  await supabaseRequest("chat_audit_logs", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      request_id: requestId,
      prompt_hash: promptHash,
      prompt_snippet: "[REDACTED]",
      verdict,
      risk_score: 0,
      violation_reason: reason || null,
      gemini_model: CONFIG.model,
      execution_status: status,
    }),
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return send(res, 405, {
      error: "Method not allowed",
    });
  }

  const missing = Object.entries(CONFIG)
    .filter(([name, value]) => name !== "model" && !value)
    .map(([name]) => name);

  if (missing.length) {
    return send(res, 503, {
      error: "Server configuration incomplete",
      missing,
    });
  }

  const requestId = crypto.randomUUID();
  const authorization = req.headers.authorization || "";
  const token = authorization.match(/^Bearer\s+(\S+)$/i)?.[1];

  if (!token) {
    return send(res, 401, {
      error: "Please sign in first",
    });
  }

  let user;

  try {
    const authResponse = await fetch(
      `${CONFIG.url}/auth/v1/user`,
      {
        headers: {
          apikey: CONFIG.anonKey,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!authResponse.ok) {
      return send(res, 401, {
        error: "Invalid or expired session",
      });
    }

    user = await authResponse.json();

    if (!user || typeof user.id !== "string") {
      return send(res, 401, {
        error: "Authentication failed",
      });
    }
  } catch {
    return send(res, 503, {
      error: "Authentication service unavailable",
    });
  }

  const body = req.body;

  if (
    !body ||
    !Array.isArray(body.messages) ||
    body.messages.length < 1 ||
    body.messages.length > 20
  ) {
    return send(res, 400, {
      error: "Invalid messages array",
    });
  }

  const messages = [];

  for (const item of body.messages) {
    if (
      !item ||
      !["user", "assistant"].includes(item.role) ||
      typeof item.content !== "string" ||
      !item.content.trim() ||
      item.content.length > 8000
    ) {
      return send(res, 400, {
        error: "Invalid message format",
      });
    }

    messages.push({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: item.content }],
    });
  }

  const lastUserMessage = [...body.messages]
    .reverse()
    .find(item => item.role === "user");

  if (
    !lastUserMessage ||
    body.messages[body.messages.length - 1].role !== "user"
  ) {
    return send(res, 400, {
      error: "The last message must be from the user",
    });
  }

  const prompt = lastUserMessage.content;

  let reserved = false;
  let verdict = "deny";

  try {
    // Atomically check and reserve quota in Supabase.
    const quota = await supabaseRequest(
      "rpc/check_and_increment_chat_quota",
      {
        method: "POST",
        body: JSON.stringify({
          p_user_id: user.id,
          p_max_per_minute: 10,
          p_max_per_day: 100,
          p_max_concurrent: 2,
        }),
      }
    );

    reserved = quota?.reserved === true;

    if (quota?.allowed !== true) {
      try {
        await writeAudit({
          userId: user.id,
          requestId,
          prompt,
          verdict: "deny",
          status: "quota_denied",
          reason: quota?.reason || "Quota denied",
        });
      } catch {
        return send(res, 503, {
          error: "Unable to record the security decision",
          requestId,
        });
      }

      return send(res, 429, {
        error: "Chat usage limit reached",
        requestId,
      });
    }

    /*
      Prototype limitation:
      This is a guarded chat endpoint, not the full tool-use
      policy engine. It does not execute privileged tools.
    */
    verdict = "allow";

    // Fail closed if the authorization event cannot be logged.
    await writeAudit({
      userId: user.id,
      requestId,
      prompt,
      verdict,
      status: "authorized",
      reason: null,
    });

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(CONFIG.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": CONFIG.geminiKey,
        },
        body: JSON.stringify({
          contents: messages,
          generationConfig: {
            maxOutputTokens: 2048,
          },
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    const result = await geminiResponse.json();

    if (!geminiResponse.ok) {
      try {
        await writeAudit({
          userId: user.id,
          requestId,
          prompt,
          verdict,
          status: "provider_error",
          reason: "Gemini provider request failed",
        });
      } catch {
        // Do not disclose internal database errors.
      }

      return send(res, 502, {
        error: "The AI provider request failed",
        requestId,
      });
    }

    const answer = result?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("");

    if (!answer) {
      await writeAudit({
        userId: user.id,
        requestId,
        prompt,
        verdict,
        status: "empty_response",
        reason: "No text returned",
      });

      return send(res, 502, {
        error: "The AI returned no text",
        requestId,
      });
    }

    // Log successful completion before returning the answer.
    await writeAudit({
      userId: user.id,
      requestId,
      prompt,
      verdict,
      status: "completed",
      reason: null,
    });

    return send(res, 200, {
      answer,
      requestId,
    });
  } catch {
    console.error("Chat backend failure", requestId);

    return send(res, 503, {
      error: "The request failed or security logging is unavailable",
      requestId,
    });
  } finally {
    if (reserved) {
      try {
        await supabaseRequest(
          "rpc/release_chat_concurrency",
          {
            method: "POST",
            body: JSON.stringify({
              p_user_id: user.id,
            }),
          }
        );
      } catch {
        console.error(
          "Quota reservation release failed",
          requestId
        );
      }
    }
  }
};
