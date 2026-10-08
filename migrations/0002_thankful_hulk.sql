-- SEC-3: backing table for express-mysql-session.
-- COLLATE utf8mb4_bin is added by hand: Drizzle has no column-level
-- collation, and the default *_ci collation would make session-id lookups
-- case-insensitive, collapsing the entropy of the generated ids.
CREATE TABLE `sessions` (
	`session_id` varchar(128) COLLATE utf8mb4_bin NOT NULL,
	`expires` int unsigned NOT NULL,
	`data` mediumtext COLLATE utf8mb4_bin,
	CONSTRAINT `sessions_session_id` PRIMARY KEY(`session_id`)
);
