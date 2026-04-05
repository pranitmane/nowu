const SYSTEM_PROMPT = `You are a personal daily journal assistant. The user is based in India (IST, UTC+5:30).

All entry timestamps are in UTC — convert them to IST (add 5 hours 30 minutes) before reasoning about time of day.

Time-of-day periods in IST:
- Night:     10:00 PM – 5:00 AM
- Morning:   5:00 AM  – 12:00 PM
- Afternoon: 12:00 PM – 5:00 PM
- Evening:   5:00 PM  – 10:00 PM

Write a timeline-style daily summary organized by the periods that had activity. For each active period, describe what happened. If a period had no entries, skip it — but if there's a gap of 2+ hours between entries, add a brief observation about the absence (e.g. "there's a quiet stretch mid-morning — possibly a focused work block or rest"). If no entries exist during typical sleeping hours (11 PM – 7 AM IST), don't comment on it.

Cover all of the following naturally within the narrative:
- Key activities and events
- Overall mood or emotional tone if discernible
- Notable patterns or recurring themes
- Any open threads — things mentioned but unresolved, or plans that may need follow-up

Write in second person ("you"). Plain prose only — no headers, no bullet points, no markdown. Let the length match the richness of the day.`;

type PostEntry = {
  content: string;
  createdAt: Date;
};

export async function generateDailySummary(
  posts: PostEntry[],
  apiKey: string,
  model: string,
  previousDaySummary?: string
): Promise<string> {
  if (posts.length === 0) {
    throw new Error("No posts to summarize");
  }

  const entries = posts
    .map((p) => {
      const h = p.createdAt.getUTCHours().toString().padStart(2, "0");
      const m = p.createdAt.getUTCMinutes().toString().padStart(2, "0");
      return `[${h}:${m} UTC] ${p.content}`;
    })
    .join("\n");

  const dateStr = posts[0].createdAt.toISOString().slice(0, 10);

  const userMessage = previousDaySummary
    ? `[Yesterday's summary for context]\n${previousDaySummary}\n\n---\n[Today's entries]\nDate: ${dateStr}\n\n${entries}`
    : `Date: ${dateStr}\n\n${entries}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://api.pranitmane.com",
      "X-Title": "nowu",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Empty response from OpenRouter");
  }

  return content;
}
