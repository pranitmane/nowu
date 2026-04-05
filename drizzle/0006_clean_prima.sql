CREATE TABLE "summaries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"content" text NOT NULL,
	"posts_count" integer NOT NULL,
	"model" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "summaries_date_unique" UNIQUE("date")
);
