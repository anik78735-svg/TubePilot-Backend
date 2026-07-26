// Uses Groq's OpenAI-compatible chat completion endpoint.
// Docs: https://console.groq.com/docs/api-reference#chat-create
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const callGroq = async (systemPrompt, userPrompt) => {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
};

const generateTitle = async (topic) => {
  const raw = await callGroq(
    'You are a YouTube SEO expert. Reply with ONLY one catchy, click-worthy YouTube video title under 90 characters. No quotes, no extra text.',
    `Video topic: ${topic}`
  );
  return raw.replace(/^["']|["']$/g, '');
};

const generateDescription = async (topic) => {
  return callGroq(
    'You are a YouTube SEO expert. Write a compelling, SEO-optimized YouTube video description (150-300 words) with a hook in the first two lines. Reply with ONLY the description text.',
    `Video topic: ${topic}`
  );
};

const generateTags = async (topic) => {
  const raw = await callGroq(
    'You are a YouTube SEO expert. Reply with ONLY a comma-separated list of 15 relevant YouTube tags/hashtags for the given topic. No numbering, no extra text.',
    `Video topic: ${topic}`
  );
  return raw.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
};

// Generates a short, natural-sounding app review based on a star rating —
// used to auto-fill the Rate Us screen so the user has something to start from.
const generateReviewText = async (stars) => {
  const tone = stars >= 4
    ? 'positive and appreciative'
    : stars === 3
      ? 'neutral, balanced, mentioning room for improvement'
      : 'constructive but polite, focused on what could be better';

  const raw = await callGroq(
    `You are writing a short, natural, first-person app store review for a YouTube upload/scheduling app called TubePilot, ` +
    `based on a star rating out of 5. The tone should be ${tone}. Reply with ONLY the review text, 1-2 sentences, no quotes, no hashtags.`,
    `Star rating: ${stars} out of 5`
  );
  return raw.replace(/^["']|["']$/g, '');
};

module.exports = { generateTitle, generateDescription, generateTags, generateReviewText };
