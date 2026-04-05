import {
  bigserial,
  bigint,
  boolean,
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const originEnum = pgEnum("origin_type", ["tg", "cli"]);

export const posts = pgTable("posts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  uid: text("uid").notNull().unique(),
  telegramMessageId: bigint("telegram_message_id", { mode: "number" }).unique(),
  authorTelegramId: bigint("author_telegram_id", { mode: "number" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  editCount: integer("edit_count").notNull().default(0),
  deleted: boolean("deleted").notNull().default(false),
  origin: originEnum("origin").notNull().default("cli"),
});

export const postVersions = pgTable(
  "post_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    postId: bigint("post_id", { mode: "number" })
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    editNumber: integer("edit_number").notNull(),
    contentSnapshot: text("content_snapshot").notNull(),
    editedBy: bigint("edited_by", { mode: "number" }),
    editedAt: timestamp("edited_at", { withTimezone: true }).notNull(),
    origin: originEnum("origin").notNull().default("cli"),
  },
  (table) => ({
    editSequenceIdx: uniqueIndex("post_versions_post_id_edit_number_idx").on(
      table.postId,
      table.editNumber
    ),
  })
);

export const summaries = pgTable("summaries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  date: date("date").notNull().unique(),
  content: text("content").notNull(),
  postsCount: integer("posts_count").notNull(),
  model: text("model").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
});

export const postsRelations = relations(posts, ({ many }) => ({
  versions: many(postVersions),
}));

export const postVersionsRelations = relations(postVersions, ({ one }) => ({
  post: one(posts, {
    fields: [postVersions.postId],
    references: [posts.id],
  }),
}));
