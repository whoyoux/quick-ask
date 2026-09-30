ALTER TABLE `turns` ADD `cost_usd` real;--> statement-breakpoint
ALTER TABLE `turns` ADD `sources` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `turns` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `turns` ADD `attachments` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `images` text;