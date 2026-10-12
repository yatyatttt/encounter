ALTER TABLE `condition_applications` ADD `effect_id` text;--> statement-breakpoint
ALTER TABLE `encounters` ADD `concentrations_json` text DEFAULT '[]' NOT NULL;