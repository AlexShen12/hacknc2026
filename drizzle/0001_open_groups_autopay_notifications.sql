CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"shopper_id" text NOT NULL,
	"group_id" text,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "auto_pay" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "origin" text DEFAULT 'matched' NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "invite_code" text;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "auto_purchase" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "auto_replace" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_shopper_idx" ON "notifications" USING btree ("session_id","shopper_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_invite_code_key" ON "groups" USING btree ("invite_code");--> statement-breakpoint
CREATE INDEX "groups_open_idx" ON "groups" USING btree ("session_id","status","offer_id");