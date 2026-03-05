import {
  bigserial,
  bigint,
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const posts = pgTable("posts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  telegramMessageId: bigint("telegram_message_id", { mode: "number" })
    .notNull()
    .unique(),
  authorTelegramId: bigint("author_telegram_id", { mode: "number" }).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  editCount: integer("edit_count").notNull().default(0),
  deleted: boolean("deleted").notNull().default(false),
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
    editedBy: bigint("edited_by", { mode: "number" }).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    editSequenceIdx: uniqueIndex("post_versions_post_id_edit_number_idx").on(
      table.postId,
      table.editNumber
    ),
  })
);

export const postsRelations = relations(posts, ({ many }) => ({
  versions: many(postVersions),
}));

export const postVersionsRelations = relations(postVersions, ({ one }) => ({
  post: one(posts, {
    fields: [postVersions.postId],
    references: [posts.id],
  }),
}));
