const GEMINI_ATTEMPT_TIMEOUT_MS = 10000;
const GEMINI_MAX_ATTEMPTS = 3;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error) {
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    [429, 500, 502, 503, 504].includes(error.status)
  );
}

async function callGemini(contents) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(CONFIG.model) +
    ":generateContent";

  let lastError;

  for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": CONFIG.geminiKey,
        },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048,
          },
        }),
        signal: AbortSignal.timeout(GEMINI_ATTEMPT_TIMEOUT_MS),
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
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === GEMINI_MAX_ATTEMPTS - 1) {
        throw error;
      }

      const backoffMs =
        500 * (2 ** attempt) + Math.floor(Math.random() * 300);

      console.warn("Temporary Gemini failure; retrying:", {
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        status: error.status || null,
        name: error.name || null,
        backoffMs,
      });

      await delay(backoffMs);
    }
  }

  throw lastError || new Error("Gemini request failed.");
}
