import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createBot } from "./bot/bot-core";
import {
  getAllEditsByUid,
  getAllPostsPaginated,
  getDeletedPostsPaginated,
  getLastPosts,
  getPostByUid,
  getPostsByDate,
  getPostTotals,
  getSummaryByDate,
  initDb,
  insertNewPost,
  restorePost,
  softDeletePostByUid,
  updatePostContentByUid,
  upsertSummary,
} from "./db/db-ops";
import { generateDailySummary } from "./services/summarize";

type Env = {
  DATABASE_URL: string;
  API_TOKEN: string;
  BOT_TOKEN: string;
  ALLOWED_USERNAMES: string;
  WEBHOOK_SECRET: string;
  OPENROUTER_API_KEY: string;
  SUMMARY_MODEL: string;
};

const app = new Hono<{ Bindings: Env }>();

// Initialize DB singleton on first request using the CF env binding.
// initDb() is idempotent — subsequent calls return immediately.
app.use("*", async (c, next) => {
  initDb(c.env.DATABASE_URL);
  await next();
});

// Auth middleware — /webhook is verified separately via secret token header.
app.use("*", async (c, next) => {
  if (c.req.path === "/webhook") return next();
  const apiToken = c.env.API_TOKEN;
  if (!apiToken) {
    return c.json({ error: "API_TOKEN is not configured on the server" }, 500);
  }
  const authHeader = c.req.header("Authorization");
  if (!authHeader || authHeader !== `Bearer ${apiToken}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// POST /webhook — receives Telegram updates
app.post("/webhook", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (!secret || secret !== c.env.WEBHOOK_SECRET) {
    return c.json({ error: "forbidden" }, 403);
  }
  const bot = createBot(c.env.BOT_TOKEN, c.env.ALLOWED_USERNAMES, {
    openrouterApiKey: c.env.OPENROUTER_API_KEY,
    summaryModel: c.env.SUMMARY_MODEL ?? "google/gemini-2.0-flash-001",
  });
  const update = await c.req.json();
  await bot.handleUpdate(update);
  return c.json({ ok: true });
});

// GET /posts
app.get("/posts", async (c) => {
  const limitParam = c.req.query("limit");
  const cursorParam = c.req.query("cursor");
  const limit = Math.min(Math.max(1, parseInt(limitParam ?? "20", 10)), 100);
  const cursor = cursorParam ? parseInt(cursorParam, 10) : undefined;
  const result = await getAllPostsPaginated(limit, cursor);
  return c.json(result);
});

// GET /posts/stats — must be before /posts/:uid
app.get("/posts/stats", async (c) => {
  const totals = await getPostTotals();
  return c.json(totals);
});

// GET /posts/last — must be before /posts/:uid
app.get("/posts/last", async (c) => {
  const nParam = c.req.query("n");
  const n = Math.min(Math.max(1, parseInt(nParam ?? "1", 10)), 10);
  const posts = await getLastPosts(n);
  return c.json({ posts });
});

// GET /posts/trash — paginated list of deleted posts; must be before /posts/:uid
app.get("/posts/trash", async (c) => {
  const limitParam = c.req.query("limit");
  const cursorParam = c.req.query("cursor");
  const limit = Math.min(Math.max(1, parseInt(limitParam ?? "20", 10)), 100);
  const cursor = cursorParam ? parseInt(cursorParam, 10) : undefined;
  const result = await getDeletedPostsPaginated(limit, cursor);
  return c.json(result);
});

// GET /posts/:uid
app.get("/posts/:uid", async (c) => {
  const uid = c.req.param("uid");
  const post = await getPostByUid(uid);
  if (!post) return c.json({ error: "post not found" }, 404);
  if (post.deleted) return c.json({ error: "post is deleted", deleted: true }, 404);
  return c.json(post);
});

// GET /posts/:uid/edits
app.get("/posts/:uid/edits", async (c) => {
  const uid = c.req.param("uid");
  const edits = await getAllEditsByUid(uid);
  if (edits.length === 0) return c.json({ error: "post not found" }, 404);
  return c.json({ edits });
});

// POST /posts
app.post("/posts", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    return c.json({ error: "content is required" }, 400);
  }
  const uid = nanoid(10);
  const post = await insertNewPost({
    uid,
    content: body.content.trim(),
    timestamp: new Date(),
    origin: "cli",
  });
  if (!post) return c.json({ error: "failed to insert post" }, 500);
  return c.json(post, 201);
});

// PATCH /posts/:uid
app.patch("/posts/:uid", async (c) => {
  const uid = c.req.param("uid");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    return c.json({ error: "content is required" }, 400);
  }
  const post = await updatePostContentByUid({
    uid,
    newContent: body.content.trim(),
    editedAt: new Date(),
  });
  if (!post) return c.json({ error: "post not found or is deleted" }, 404);
  return c.json(post);
});

// DELETE /posts/:uid
app.delete("/posts/:uid", async (c) => {
  const uid = c.req.param("uid");
  const post = await softDeletePostByUid(uid);
  if (!post) return c.json({ error: "post not found" }, 404);
  return c.json(post);
});

// POST /posts/:uid/restore
app.post("/posts/:uid/restore", async (c) => {
  const uid = c.req.param("uid");
  const post = await restorePost(uid);
  if (!post) return c.json({ error: "post not found" }, 404);
  return c.json(post);
});

function getTodayIst(): string {
  const IST_OFFSET_MS = 330 * 60 * 1000;
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function isValidDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

async function buildAndGenerateSummary(dateParam: string, apiKey: string, model: string) {
  const prevDate = new Date(dateParam + "T00:00:00Z");
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const prevDateStr = prevDate.toISOString().slice(0, 10);
  const prevSummary = await getSummaryByDate(prevDateStr);

  const dayPosts = await getPostsByDate(dateParam);
  if (dayPosts.length === 0) return null;

  const content = await generateDailySummary(dayPosts, apiKey, model, prevSummary?.content);
  return upsertSummary({ date: dateParam, content, postsCount: dayPosts.length, model, generatedAt: new Date() });
}

// GET /ai/summary?date=YYYY-MM-DD
app.get("/ai/summary", async (c) => {
  const dateParam = c.req.query("date");
  if (!dateParam || !isValidDateStr(dateParam)) {
    return c.json({ error: "date query param required (YYYY-MM-DD)" }, 400);
  }
  if (dateParam > getTodayIst()) {
    return c.json({ error: "date is in the future" }, 400);
  }

  const apiKey = c.env.OPENROUTER_API_KEY;
  const model = c.env.SUMMARY_MODEL ?? "google/gemini-2.0-flash-001";
  if (!apiKey) {
    return c.json({ error: "OPENROUTER_API_KEY is not configured" }, 500);
  }

  const cached = await getSummaryByDate(dateParam);
  if (cached) return c.json(cached);

  const summary = await buildAndGenerateSummary(dateParam, apiKey, model);
  if (!summary) return c.json({ error: `no posts found for ${dateParam}` }, 404);
  return c.json(summary);
});

// POST /ai/summary?date=YYYY-MM-DD — force regenerate for any date
app.post("/ai/summary", async (c) => {
  const dateParam = c.req.query("date");
  if (!dateParam || !isValidDateStr(dateParam)) {
    return c.json({ error: "date query param required (YYYY-MM-DD)" }, 400);
  }
  if (dateParam > getTodayIst()) {
    return c.json({ error: "date is in the future" }, 400);
  }

  const apiKey = c.env.OPENROUTER_API_KEY;
  const model = c.env.SUMMARY_MODEL ?? "google/gemini-2.0-flash-001";
  if (!apiKey) {
    return c.json({ error: "OPENROUTER_API_KEY is not configured" }, 500);
  }

  const summary = await buildAndGenerateSummary(dateParam, apiKey, model);
  if (!summary) return c.json({ error: `no posts found for ${dateParam}` }, 404);
  return c.json(summary);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: { scheduledTime: number }, env: Env, _ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    initDb(env.DATABASE_URL);
    // Cron fires at 18:30 UTC = midnight IST. Generate summary for the IST day that just ended.
    const IST_OFFSET_MS = 330 * 60 * 1000;
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    istNow.setUTCDate(istNow.getUTCDate() - 1);
    const dateStr = istNow.toISOString().slice(0, 10);
    const model = env.SUMMARY_MODEL ?? "google/gemini-2.0-flash-001";

    const prevDate = new Date(dateStr + "T00:00:00Z");
    prevDate.setUTCDate(prevDate.getUTCDate() - 1);
    const prevSummary = await getSummaryByDate(prevDate.toISOString().slice(0, 10));

    const dayPosts = await getPostsByDate(dateStr);
    if (dayPosts.length === 0) return;
    const content = await generateDailySummary(dayPosts, env.OPENROUTER_API_KEY, model, prevSummary?.content);
    await upsertSummary({
      date: dateStr,
      content,
      postsCount: dayPosts.length,
      model,
      generatedAt: new Date(),
    });
  },
};
