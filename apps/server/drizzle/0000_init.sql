CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload_json` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`unique_key` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`run_after` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`locked_by` text,
	`locked_at` integer,
	`last_error` text,
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_after_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `jobs_type_status_idx` ON `jobs` (`type`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_unique_key_active_unique` ON `jobs` (`unique_key`) WHERE "jobs"."unique_key" is not null and "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE TABLE `library_items` (
	`server_item_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`artist_name` text,
	`album_name` text,
	`duration_ms` integer,
	`mb_recording_id` text,
	`mb_release_group_id` text,
	`mb_artist_id` text,
	`norm_key` text,
	`path` text,
	`synced_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `library_items_mb_recording_idx` ON `library_items` (`mb_recording_id`);--> statement-breakpoint
CREATE INDEX `library_items_mb_release_group_idx` ON `library_items` (`mb_release_group_id`);--> statement-breakpoint
CREATE INDEX `library_items_mb_artist_idx` ON `library_items` (`mb_artist_id`);--> statement-breakpoint
CREATE INDEX `library_items_norm_key_idx` ON `library_items` (`norm_key`);--> statement-breakpoint
CREATE INDEX `library_items_kind_idx` ON `library_items` (`kind`);--> statement-breakpoint
CREATE TABLE `mb_cache` (
	`url_key` text PRIMARY KEY NOT NULL,
	`body_json` text NOT NULL,
	`fetched_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`ttl_seconds` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mb_cache_fetched_at_idx` ON `mb_cache` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `notification_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`agent` text NOT NULL,
	`config_json` text NOT NULL,
	`events` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`actor_id` text,
	`from_status` text,
	`to_status` text NOT NULL,
	`note` text,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `request_events_request_idx` ON `request_events` (`request_id`,`at`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`mbid` text NOT NULL,
	`parent_mbid` text,
	`title` text NOT NULL,
	`artist_name` text,
	`cover_url` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`requested_by` text NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decline_reason` text,
	`provider_id` text,
	`provider_ref` text,
	`fulfilled_by_upload_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`fulfilled_by_upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `requests_mbid_type_idx` ON `requests` (`mbid`,`type`);--> statement-breakpoint
CREATE INDEX `requests_requested_by_idx` ON `requests` (`requested_by`);--> statement-breakpoint
CREATE INDEX `requests_status_idx` ON `requests` (`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text,
	`tus_id` text,
	`uploader_id` text NOT NULL,
	`original_name` text NOT NULL,
	`staging_path` text,
	`size` integer DEFAULT 0 NOT NULL,
	`sha256` text,
	`format` text,
	`duration_ms` integer,
	`bitrate` integer,
	`sample_rate` integer,
	`fingerprint` text,
	`status` text DEFAULT 'RECEIVING' NOT NULL,
	`match_json` text,
	`chosen_json` text,
	`library_path` text,
	`target_request_id` text,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `uploads_sha256_idx` ON `uploads` (`sha256`);--> statement-breakpoint
CREATE INDEX `uploads_status_idx` ON `uploads` (`status`);--> statement-breakpoint
CREATE INDEX `uploads_uploader_idx` ON `uploads` (`uploader_id`);--> statement-breakpoint
CREATE INDEX `uploads_batch_idx` ON `uploads` (`batch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_tus_id_unique` ON `uploads` (`tus_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`display_name` text,
	`avatar` text,
	`auth_type` text NOT NULL,
	`external_id` text,
	`password_hash` text,
	`permissions` integer DEFAULT 280 NOT NULL,
	`request_quota_limit` integer,
	`request_quota_days` integer,
	`upload_quota_mb` integer,
	`upload_quota_days` integer,
	`notify_prefs` text,
	`last_login_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX `users_auth_external_unique` ON `users` (`auth_type`,`external_id`);