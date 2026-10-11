ALTER TABLE "sync_outbox" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "sync_outbox" CASCADE;--> statement-breakpoint
ALTER TABLE "bank_operations" ALTER COLUMN "group_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_operations" ADD COLUMN "shopper_id" text;--> statement-breakpoint
ALTER TABLE "bank_operations" ADD CONSTRAINT "bank_operations_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE no action ON UPDATE no action;