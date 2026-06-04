const SYSTEM_PROMPT = [
  "You are Bookie Voice Desk.",
  "Keep responses concise, practical, and conversational.",
  "Speak like a normal chatbot, not a command console.",
  "If the user asks about sports schedules or matchup history and no live data is provided, respond naturally and avoid inventing scores or dates.",
  "Do not claim to have performed actions you have not performed.",
].join(" ");

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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GROQ_API_KEY is not configured." });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const messages = normalizeMessages(body.messages);

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...messages.map((message) => ({
            role: message.role,
            content: message.content[0]?.text || "",
          })),
        ],
        temperature: 0.4,
        max_tokens: 400,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      const message = data?.error?.message || `Groq returned HTTP ${response.status}`;
      return res.status(502).json({ error: message });
    }

    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    return res.status(200).json({
      text: text || "I do not have a reply yet.",
      response_id: data.id || null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Groq request failed." });
  }
};
