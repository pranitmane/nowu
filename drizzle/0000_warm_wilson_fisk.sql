CREATE TABLE "post_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"post_id" bigint NOT NULL,
	"edit_number" integer NOT NULL,
	"content_snapshot" text NOT NULL,
	"edited_by" bigint NOT NULL,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"author_telegram_id" bigint NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "posts_telegram_message_id_unique" UNIQUE("telegram_message_id")
);
--> statement-breakpoint
ALTER TABLE "post_versions" ADD CONSTRAINT "post_versions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_versions_post_id_edit_number_idx" ON "post_versions" USING btree ("post_id","edit_number");