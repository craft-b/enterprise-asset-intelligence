-- drift_reference: the reference distributions PSI is measured against, moved
-- out of ml-service/registry/*.json and into the database. See the table's
-- comment in shared/schema.ts for why a file could not hold it.
--
-- Both CREATE TABLEs are IF NOT EXISTS, and so is the index.
--
-- seed_runs appears here because it was created directly against the deployed
-- database rather than through a migration, so it exists in production while
-- being absent from migration history -- generate therefore emits it as new.
-- Plain CREATE TABLE would fail on that database and leave this migration
-- half-applied, with drift_reference created and the migration unrecorded.
-- IF NOT EXISTS makes the file correct against both a fresh database and the
-- deployed one.
CREATE TABLE IF NOT EXISTS `drift_reference` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`computed_at` timestamp NOT NULL DEFAULT (now()),
	`model_version` varchar(50) NOT NULL,
	`feature_count` int NOT NULL DEFAULT 0,
	`horizon_count` int NOT NULL DEFAULT 0,
	`bias_category_count` int NOT NULL DEFAULT 0,
	`n_samples` int NOT NULL DEFAULT 0,
	`n_assets` int NOT NULL DEFAULT 0,
	`payload` mediumtext NOT NULL,
	CONSTRAINT `drift_reference_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `seed_runs` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`status` varchar(20) NOT NULL,
	`steps` mediumtext,
	`warnings` mediumtext,
	`error` text,
	`started_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`finished_at` timestamp,
	CONSTRAINT `seed_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_computed_at` ON `drift_reference` (`computed_at`);
