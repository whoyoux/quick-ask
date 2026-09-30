CREATE TABLE `conversations` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` integer PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`position` integer NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`transcription_model` text NOT NULL,
	`chat_model` text NOT NULL,
	`transcription_ms` integer,
	`first_token_ms` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_turns_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "turns_status_check" CHECK("status" in ('done', 'error'))
);
--> statement-breakpoint
CREATE INDEX `conversations_updated_at_idx` ON `conversations` (`updated_at`);--> statement-breakpoint
CREATE INDEX `turns_conversation_idx` ON `turns` (`conversation_id`,`position`);