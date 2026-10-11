CREATE TABLE "rehearsal_bills" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"account_id" text NOT NULL,
	"payee" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"due_date" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "baseline_estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rehearsal_bills" ADD CONSTRAINT "rehearsal_bills_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rehearsal_bills" ADD CONSTRAINT "rehearsal_bills_account_id_rehearsal_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."rehearsal_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rehearsal_bills_account_idx" ON "rehearsal_bills" USING btree ("account_id");