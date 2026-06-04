const SYSTEM_PROMPT = [
  "You are Bookie Voice Desk.",
  "Keep responses concise, practical, and conversational.",
  "Speak like a normal chatbot, not a command console.",
  "If the user asks about sports schedules or matchup history and no live data is provided, respond naturally and avoid inventing scores or dates.",
  "Do not claim to have performed actions you have not performed.",
].join(" ");

function extractText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const parts = [];
  for (const item of response.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (content?.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("").trim();
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && typeof message.content === "string")
    .slice(-12)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: [{ type: "input_text", text: message.content }],
    }));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not configured." });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const messages = normalizeMessages(body.messages);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        input: [
          {
            role: "developer",
            content: [{ type: "input_text", text: SYSTEM_PROMPT }],
          },
          ...messages,
        ],
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      const message = data?.error?.message || `OpenAI returned HTTP ${response.status}`;
      return res.status(502).json({ error: message });
    }

    const text = extractText(data);
    return res.status(200).json({
      text: text || "I do not have a reply yet.",
      response_id: data.id || null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "OpenAI request failed." });
  }
};
