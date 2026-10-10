CREATE TABLE "allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"group_id" text NOT NULL,
	"need_id" text NOT NULL,
	"shopper_id" text NOT NULL,
	"position" integer NOT NULL,
	"quantity" integer NOT NULL,
	"contribution_cents" integer NOT NULL,
	"baseline_cents" integer NOT NULL,
	"savings_cents" integer NOT NULL,
	"state" text NOT NULL,
	"consent" jsonb,
	"contribution_operation_id" text,
	"return_operation_id" text,
	"replaces_allocation_id" text,
	"departed_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocations_savings_check" CHECK ("allocations"."savings_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "bank_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"group_id" text NOT NULL,
	"allocation_id" text,
	"kind" text NOT NULL,
	"operation_key" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"from_account_ref" text NOT NULL,
	"to_ref" text NOT NULL,
	"status" text NOT NULL,
	"provider_id" text,
	"provider_status" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" jsonb,
	"related_operation_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_operations_amount_check" CHECK ("bank_operations"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "demo_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"mode" text NOT NULL,
	"selected_shopper_id" text,
	"scenario_version" text NOT NULL,
	"catalog_version" text NOT NULL,
	"provisioning_status" text NOT NULL,
	"provisioning_error" text,
	"pickup_zone" jsonb NOT NULL,
	"pickup_windows" jsonb NOT NULL,
	"rehearsal_fault" text,
	"collection_customer_ref" text,
	"merchant_refs" jsonb NOT NULL,
	"previous_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_sessions_mode_check" CHECK ("demo_sessions"."mode" in ('sponsor', 'rehearsal'))
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_snapshot" jsonb NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"initiating_need_id" text NOT NULL,
	"organizer_shopper_id" text,
	"collection_account_ref" text,
	"analytics_snapshot" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"package_quantity" integer NOT NULL,
	"pickup_zone" text NOT NULL,
	"pickup_window" text NOT NULL,
	"event_seq" integer DEFAULT 0 NOT NULL,
	"explanation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "needs" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"shopper_id" text NOT NULL,
	"accepted_offer_ids" jsonb NOT NULL,
	"quantity" integer NOT NULL,
	"max_contribution_cents" integer NOT NULL,
	"pickup_zone" text NOT NULL,
	"pickup_window" text NOT NULL,
	"status" text NOT NULL,
	"reserved_group_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "needs_quantity_check" CHECK ("needs"."quantity" > 0),
	CONSTRAINT "needs_max_check" CHECK ("needs"."max_contribution_cents" >= 0),
	CONSTRAINT "needs_reservation_check" CHECK (("needs"."status" = 'reserved') = ("needs"."reserved_group_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"offer_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"retailer" text NOT NULL,
	"store_name" text NOT NULL,
	"sku" text NOT NULL,
	"product_family" text NOT NULL,
	"product_name" text NOT NULL,
	"unit" text NOT NULL,
	"package_quantity" integer NOT NULL,
	"item_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"fee_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"baselines" jsonb NOT NULL,
	"membership_required" text,
	"pickup_zone" text NOT NULL,
	"pickup_windows" jsonb NOT NULL,
	"available" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"image" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_url" text,
	"retrieved_at" timestamp with time zone NOT NULL,
	"fixture_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_total_check" CHECK ("offers"."total_cents" = "offers"."item_cents" + "offers"."tax_cents" + "offers"."fee_cents"),
	CONSTRAINT "offers_package_check" CHECK ("offers"."package_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "operation_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"provider_id" text,
	"error" jsonb
);
--> statement-breakpoint
CREATE TABLE "rehearsal_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"label" text NOT NULL,
	"balance_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rehearsal_accounts_balance_check" CHECK ("rehearsal_accounts"."balance_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rehearsal_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"payer_account_id" text NOT NULL,
	"payee_account_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shoppers" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"persona_key" text NOT NULL,
	"display_name" text NOT NULL,
	"tagline" text NOT NULL,
	"customer_ref" text,
	"funding_account_ref" text,
	"opening_balance_cents" integer NOT NULL,
	"buffer_cents" integer NOT NULL,
	"memberships" jsonb NOT NULL,
	"draft_need" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shoppers_buffer_check" CHECK ("shoppers"."buffer_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sync_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"group_id" text,
	"seq" integer,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_need_id_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_operations" ADD CONSTRAINT "bank_operations_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_operations" ADD CONSTRAINT "bank_operations_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "needs" ADD CONSTRAINT "needs_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "needs" ADD CONSTRAINT "needs_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_attempts" ADD CONSTRAINT "operation_attempts_operation_id_bank_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."bank_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rehearsal_accounts" ADD CONSTRAINT "rehearsal_accounts_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rehearsal_transactions" ADD CONSTRAINT "rehearsal_transactions_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rehearsal_transactions" ADD CONSTRAINT "rehearsal_transactions_payer_account_id_rehearsal_accounts_id_fk" FOREIGN KEY ("payer_account_id") REFERENCES "public"."rehearsal_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rehearsal_transactions" ADD CONSTRAINT "rehearsal_transactions_payee_account_id_rehearsal_accounts_id_fk" FOREIGN KEY ("payee_account_id") REFERENCES "public"."rehearsal_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shoppers" ADD CONSTRAINT "shoppers_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_session_id_demo_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocations_group_need_key" ON "allocations" USING btree ("group_id","need_id");--> statement-breakpoint
CREATE INDEX "allocations_group_idx" ON "allocations" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_operations_key" ON "bank_operations" USING btree ("operation_key");--> statement-breakpoint
CREATE INDEX "bank_operations_group_idx" ON "bank_operations" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_sessions_token_hash_key" ON "demo_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "groups_session_idx" ON "groups" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "needs_session_status_idx" ON "needs" USING btree ("session_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_session_key" ON "offers" USING btree ("session_id","offer_key");--> statement-breakpoint
CREATE UNIQUE INDEX "operation_attempts_number_key" ON "operation_attempts" USING btree ("operation_id","attempt_number");--> statement-breakpoint
CREATE INDEX "rehearsal_transactions_description_idx" ON "rehearsal_transactions" USING btree ("description");--> statement-breakpoint
CREATE UNIQUE INDEX "shoppers_session_persona_key" ON "shoppers" USING btree ("session_id","persona_key");--> statement-breakpoint
CREATE INDEX "sync_outbox_pending_idx" ON "sync_outbox" USING btree ("session_id","status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_events_group_seq_key" ON "workflow_events" USING btree ("group_id","seq");--> statement-breakpoint
CREATE INDEX "workflow_events_session_idx" ON "workflow_events" USING btree ("session_id","id");