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

// Platform-aware caption generator. Instagram and Facebook have different
// tone/length conventions, so the system prompt is branched per platform
// rather than reusing the YouTube description generator — this is what
// keeps captions from ever being a copy of the YouTube title/description.
const CAPTION_PROMPTS = {
  instagram: 'You are a social media copywriter specializing in Instagram Reels. Write a short, punchy, engaging caption (1-3 sentences, conversational tone, can include 1-2 emojis) that hooks viewers in the first line. Reply with ONLY the caption text, no hashtags.',
  facebook: 'You are a social media copywriter specializing in Facebook video posts. Write a friendly, slightly longer caption (2-4 sentences) that encourages comments and shares. Reply with ONLY the caption text, no hashtags.'
};

const generateCaption = async (topic, platform) => {
  const systemPrompt = CAPTION_PROMPTS[platform] || CAPTION_PROMPTS.instagram;
  return callGroq(systemPrompt, `Video/Reel topic: ${topic}`);
};

// Platform-aware hashtag generator. Instagram favors more hashtags than
// Facebook, per each platform's own best-practice conventions.
const HASHTAG_PROMPTS = {
  instagram: 'You are a social media growth expert specializing in Instagram Reels. Reply with ONLY a comma-separated list of 20 relevant, trending Instagram hashtags for the given topic (mix of broad and niche tags). No numbering, no extra text, no # symbol.',
  facebook: 'You are a social media growth expert specializing in Facebook video posts. Reply with ONLY a comma-separated list of 8 relevant Facebook hashtags for the given topic. No numbering, no extra text, no # symbol.'
};

const generateHashtags = async (topic, platform) => {
  const systemPrompt = HASHTAG_PROMPTS[platform] || HASHTAG_PROMPTS.instagram;
  const raw = await callGroq(systemPrompt, `Video/Reel topic: ${topic}`);
  return raw.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
};

module.exports = { generateTitle, generateDescription, generateTags, generateCaption, generateHashtags };
