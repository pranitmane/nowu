import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { postVersions, posts, summaries } from "./schema";

// In Node.js (local dev), inject the ws package as the WebSocket implementation.
// In CF Workers, globalThis.WebSocket is natively available so this block is skipped.
if (typeof globalThis.WebSocket === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  neonConfig.webSocketConstructor = require("ws");
}

type PostRecord = typeof posts.$inferSelect;
type PostVersionRecord = typeof postVersions.$inferSelect;
type PostEditRecord = PostVersionRecord & { isCurrent?: boolean };

type InsertPostParams = {
  uid: string;
  telegramMessageId?: number;
  authorTelegramId?: number;
  content: string;
  timestamp: Date;
  origin?: "tg" | "cli";
};

type UpdatePostParams = {
  targetTelegramMessageId: number;
  newContent: string;
  editedBy: number;
  editedAt: Date;
};

type UpdatePostByUidParams = {
  uid: string;
  newContent: string;
  editedBy?: number;
  editedAt: Date;
};

type DeletePostParams = {
  targetTelegramMessageId: number;
  deletedAt: Date;
};

type PostTotals = {
  total: number;
  visible: number;
  deleted: number;
};

export type SummaryRecord = typeof summaries.$inferSelect;

type UpsertSummaryParams = {
  date: string;
  content: string;
  postsCount: number;
  model: string;
  generatedAt: Date;
};

type PaginatedPosts = {
  posts: PostRecord[];
  nextCursor: number | null;
};

type DrizzleDb = ReturnType<typeof drizzle>;

let sharedPool: Pool | null = null;
let sharedDb: DrizzleDb | null = null;

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not defined. Please set it before performing database operations."
    );
  }
  return databaseUrl;
}

function getDb(): DrizzleDb {
  if (sharedDb) {
    return sharedDb;
  }

  const databaseUrl = requireDatabaseUrl();
  sharedPool = new Pool({ connectionString: databaseUrl });
  sharedDb = drizzle(sharedPool);
  return sharedDb;
}

// Called by the CF Worker middleware on every request.
// Creates a fresh Pool per request — no caching. This avoids CF Workers'
// I/O isolation error ("Cannot perform I/O on behalf of a different request")
// that occurs when a WebSocket-backed Pool is cached from request A's context
// and reused in request B. The Neon pooler handles actual DB connection pooling.
export function initDb(connectionString: string): void {
  sharedPool = new Pool({ connectionString });
  sharedDb = drizzle(sharedPool);
}

export async function shutdownDatabasePool(): Promise<void> {
  await sharedPool?.end();
  sharedPool = null;
  sharedDb = null;
}

export async function verifyDatabaseConnection(): Promise<void> {
  const db = getDb();
  await db.execute(sql`select 1`);
}

export async function insertNewPost(
  params: InsertPostParams
): Promise<PostRecord | null> {
  const db = getDb();

  const query = db.insert(posts).values({
    uid: params.uid,
    telegramMessageId: params.telegramMessageId ?? null,
    authorTelegramId: params.authorTelegramId ?? null,
    content: params.content,
    createdAt: params.timestamp,
    updatedAt: params.timestamp,
    editCount: 0,
    deleted: false,
    origin: params.origin ?? "cli",
  });

  const [inserted] = params.telegramMessageId
    ? await query
        .onConflictDoNothing({ target: posts.telegramMessageId })
        .returning()
    : await query.returning();

  return inserted ?? null;
}

export async function getPostByTelegramMessageId(
  messageId: number
): Promise<PostRecord | null> {
  const db = getDb();
  const [post] = await db
    .select()
    .from(posts)
    .where(eq(posts.telegramMessageId, messageId))
    .limit(1);
  return post ?? null;
}

export async function getPostByUid(uid: string): Promise<PostRecord | null> {
  const db = getDb();
  const [post] = await db
    .select()
    .from(posts)
    .where(eq(posts.uid, uid))
    .limit(1);
  return post ?? null;
}

export async function updatePostContent(
  params: UpdatePostParams
): Promise<PostRecord | null> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(posts)
      .where(eq(posts.telegramMessageId, params.targetTelegramMessageId))
      .limit(1);

    if (!existing || existing.deleted) {
      return null;
    }

    await tx.insert(postVersions).values({
      postId: existing.id,
      editNumber: existing.editCount + 1,
      contentSnapshot: existing.content,
      editedBy: params.editedBy,
      editedAt: params.editedAt,
      origin: existing.origin,
    });

    const [updated] = await tx
      .update(posts)
      .set({
        content: params.newContent,
        updatedAt: params.editedAt,
        editCount: existing.editCount + 1,
      })
      .where(eq(posts.id, existing.id))
      .returning();

    return updated ?? null;
  });
}

export async function updatePostContentByUid(
  params: UpdatePostByUidParams
): Promise<PostRecord | null> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(posts)
      .where(eq(posts.uid, params.uid))
      .limit(1);

    if (!existing || existing.deleted) {
      return null;
    }

    await tx.insert(postVersions).values({
      postId: existing.id,
      editNumber: existing.editCount + 1,
      contentSnapshot: existing.content,
      editedBy: params.editedBy ?? null,
      editedAt: params.editedAt,
      origin: existing.origin,
    });

    const [updated] = await tx
      .update(posts)
      .set({
        content: params.newContent,
        updatedAt: params.editedAt,
        editCount: existing.editCount + 1,
      })
      .where(eq(posts.id, existing.id))
      .returning();

    return updated ?? null;
  });
}

export async function softDeletePost(
  params: DeletePostParams
): Promise<PostRecord | null> {
  const db = getDb();
  const [deletedPost] = await db
    .update(posts)
    .set({
      deleted: true,
      updatedAt: params.deletedAt,
    })
    .where(eq(posts.telegramMessageId, params.targetTelegramMessageId))
    .returning();
  return deletedPost ?? null;
}

export async function softDeletePostByUid(
  uid: string
): Promise<PostRecord | null> {
  const db = getDb();
  const [deletedPost] = await db
    .update(posts)
    .set({
      deleted: true,
      updatedAt: new Date(),
    })
    .where(eq(posts.uid, uid))
    .returning();
  return deletedPost ?? null;
}

export async function restorePost(uid: string): Promise<PostRecord | null> {
  const db = getDb();
  const [restored] = await db
    .update(posts)
    .set({
      deleted: false,
      updatedAt: new Date(),
    })
    .where(eq(posts.uid, uid))
    .returning();
  return restored ?? null;
}

export async function getAllPosts(): Promise<PostRecord[]> {
  const db = getDb();
  const rows = await db.select().from(posts).orderBy(desc(posts.createdAt));
  return rows;
}

export async function getAllPostsPaginated(
  limit: number,
  cursor?: number
): Promise<PaginatedPosts> {
  const db = getDb();

  const conditions = [eq(posts.deleted, false)];
  if (cursor) conditions.push(lt(posts.id, cursor));
  const where = and(...conditions);

  const rows = await db
    .select()
    .from(posts)
    .where(where)
    .orderBy(desc(posts.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  return { posts: data, nextCursor };
}

export async function getDeletedPostsPaginated(
  limit: number,
  cursor?: number
): Promise<PaginatedPosts> {
  const db = getDb();

  const conditions = [eq(posts.deleted, true)];
  if (cursor) conditions.push(lt(posts.id, cursor));
  const where = and(...conditions);

  const rows = await db
    .select()
    .from(posts)
    .where(where)
    .orderBy(desc(posts.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  return { posts: data, nextCursor };
}

export async function getLastPosts(n: number): Promise<PostRecord[]> {
  const db = getDb();
  const count = Math.min(Math.max(1, n), 10);
  return db
    .select()
    .from(posts)
    .where(eq(posts.deleted, false))
    .orderBy(desc(posts.createdAt))
    .limit(count);
}

export async function getLastDeletedPosts(n: number): Promise<PostRecord[]> {
  const db = getDb();
  const count = Math.min(Math.max(1, n), 10);
  return db
    .select()
    .from(posts)
    .where(eq(posts.deleted, true))
    .orderBy(desc(posts.createdAt))
    .limit(count);
}

export async function getAllEdits(
  telegramMessageId: number
): Promise<PostEditRecord[]> {
  const db = getDb();
  const [post] = await db
    .select({
      id: posts.id,
      content: posts.content,
      editCount: posts.editCount,
      authorTelegramId: posts.authorTelegramId,
      updatedAt: posts.updatedAt,
      origin: posts.origin,
    })
    .from(posts)
    .where(eq(posts.telegramMessageId, telegramMessageId))
    .limit(1);

  if (!post) {
    return [];
  }

  const versions = await db
    .select()
    .from(postVersions)
    .where(eq(postVersions.postId, post.id))
    .orderBy(desc(postVersions.editNumber));

  const currentVersion: PostEditRecord = {
    id: post.id,
    postId: post.id,
    editNumber: post.editCount + 1,
    contentSnapshot: post.content,
    editedBy: post.authorTelegramId ?? null,
    editedAt: post.updatedAt,
    origin: post.origin,
    isCurrent: true,
  };

  return [currentVersion, ...versions];
}

export async function getAllEditsByUid(
  uid: string
): Promise<PostEditRecord[]> {
  const db = getDb();
  const [post] = await db
    .select({
      id: posts.id,
      content: posts.content,
      editCount: posts.editCount,
      authorTelegramId: posts.authorTelegramId,
      updatedAt: posts.updatedAt,
      origin: posts.origin,
    })
    .from(posts)
    .where(eq(posts.uid, uid))
    .limit(1);

  if (!post) {
    return [];
  }

  const versions = await db
    .select()
    .from(postVersions)
    .where(eq(postVersions.postId, post.id))
    .orderBy(desc(postVersions.editNumber));

  const currentVersion: PostEditRecord = {
    id: post.id,
    postId: post.id,
    editNumber: post.editCount + 1,
    contentSnapshot: post.content,
    editedBy: post.authorTelegramId ?? null,
    editedAt: post.updatedAt,
    origin: post.origin,
    isCurrent: true,
  };

  return [currentVersion, ...versions];
}

export async function getPostsByDate(dateStr: string): Promise<PostRecord[]> {
  const db = getDb();
  // IST is UTC+5:30 (330 minutes). An IST calendar day runs from 18:30 UTC (prev day)
  // to 18:30 UTC (same day), so we query that range instead of a UTC date boundary.
  return db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.deleted, false),
        sql`${posts.createdAt} >= ${dateStr}::date - INTERVAL '330 minutes'`,
        sql`${posts.createdAt} < ${dateStr}::date + INTERVAL '1 day' - INTERVAL '330 minutes'`
      )
    )
    .orderBy(asc(posts.createdAt));
}

export async function getSummaryByDate(dateStr: string): Promise<SummaryRecord | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(summaries)
    .where(eq(summaries.date, dateStr))
    .limit(1);
  return row ?? null;
}

export async function upsertSummary(params: UpsertSummaryParams): Promise<SummaryRecord> {
  const db = getDb();
  const [row] = await db
    .insert(summaries)
    .values({
      date: params.date,
      content: params.content,
      postsCount: params.postsCount,
      model: params.model,
      generatedAt: params.generatedAt,
    })
    .onConflictDoUpdate({
      target: summaries.date,
      set: {
        content: params.content,
        postsCount: params.postsCount,
        model: params.model,
        generatedAt: params.generatedAt,
      },
    })
    .returning();
  return row;
}

export async function getPostTotals(): Promise<PostTotals> {
  const db = getDb();
  const [counts] = await db
    .select({
      total: sql<number>`count(*)`,
      deleted: sql<number>`count(*) filter (where ${posts.deleted} = true)`,
    })
    .from(posts);

  const total = counts?.total ?? 0;
  const deleted = counts?.deleted ?? 0;
  const visible = total - deleted;
  return { total, deleted, visible };
}
