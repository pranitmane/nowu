//note for agents -- any changes made to this file should reflect in the worker.ts file as well, since both serve the same API but in different environments (Node server vs Cloudflare Worker)
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import {
  getAllEditsByUid,
  getAllPostsPaginated,
  getDeletedPostsPaginated,
  getLastPosts,
  getPostByUid,
  getPostsByDate,
  getPostTotals,
  getSummaryByDate,
  insertNewPost,
  restorePost,
  softDeletePostByUid,
  updatePostContentByUid,
  upsertSummary,
} from "../db/db-ops";
import { generateDailySummary } from "../services/summarize";

const app = new Hono();

const ALLOWED_ORIGINS = [
  "https://nowu.pranitmane.com",
  ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
];

app.use("*", cors({
  origin: (origin) => ALLOWED_ORIGINS.includes(origin) ? origin : "",
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type"],
}));

// Auth middleware — all routes require a valid Bearer token
app.use("*", async (c, next) => {
  const apiToken = process.env.API_TOKEN;
  if (!apiToken) {
    return c.json({ error: "API_TOKEN is not configured on the server" }, 500);
  }
  const authHeader = c.req.header("Authorization");
  if (!authHeader || authHeader !== `Bearer ${apiToken}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// GET /posts — paginated list of non-deleted posts (cursor = internal bigserial id)
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
  if (!post) {
    return c.json({ error: "post not found" }, 404);
  }
  if (post.deleted) {
    return c.json({ error: "post is deleted", deleted: true }, 404);
  }
  return c.json(post);
});

// GET /posts/:uid/edits
app.get("/posts/:uid/edits", async (c) => {
  const uid = c.req.param("uid");
  const edits = await getAllEditsByUid(uid);
  if (edits.length === 0) {
    return c.json({ error: "post not found" }, 404);
  }
  return c.json({ edits });
});

const ALLOWED_API_ORIGINS = ["cli", "web"] as const;
type ApiOrigin = (typeof ALLOWED_API_ORIGINS)[number];

// POST /posts — create a new post (CLI origin by default; pass origin:"web" for web clients)
app.post("/posts", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    return c.json({ error: "content is required" }, 400);
  }

  const origin: ApiOrigin = ALLOWED_API_ORIGINS.includes(body.origin) ? body.origin : "cli";

  const uid = nanoid(10);
  const post = await insertNewPost({
    uid,
    content: body.content.trim(),
    timestamp: new Date(),
    origin,
  });

  if (!post) {
    return c.json({ error: "failed to insert post" }, 500);
  }

  return c.json(post, 201);
});

// PATCH /posts/:uid — update post content
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

  if (!post) {
    return c.json({ error: "post not found or is deleted" }, 404);
  }

  return c.json(post);
});

// DELETE /posts/:uid — soft delete
app.delete("/posts/:uid", async (c) => {
  const uid = c.req.param("uid");
  const post = await softDeletePostByUid(uid);
  if (!post) {
    return c.json({ error: "post not found" }, 404);
  }
  return c.json(post);
});

// POST /posts/:uid/restore
app.post("/posts/:uid/restore", async (c) => {
  const uid = c.req.param("uid");
  const post = await restorePost(uid);
  if (!post) {
    return c.json({ error: "post not found" }, 404);
  }
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

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.SUMMARY_MODEL ?? "google/gemini-2.0-flash-001";
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

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.SUMMARY_MODEL ?? "google/gemini-2.0-flash-001";
  if (!apiKey) {
    return c.json({ error: "OPENROUTER_API_KEY is not configured" }, 500);
  }

  const summary = await buildAndGenerateSummary(dateParam, apiKey, model);
  if (!summary) return c.json({ error: `no posts found for ${dateParam}` }, 404);
  return c.json(summary);
});

const port = parseInt(process.env.PORT ?? "3000", 10);

serve({ fetch: app.fetch, port }, () => {
  console.log(`API server running on http://localhost:${port}`);
});
