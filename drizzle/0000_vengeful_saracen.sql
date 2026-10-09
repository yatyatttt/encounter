CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `encounter_combatants` (
	`id` text PRIMARY KEY NOT NULL,
	`encounter_id` text NOT NULL,
	`template_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`max_hp` integer NOT NULL,
	`current_hp` integer NOT NULL,
	`temp_hp` integer NOT NULL,
	`starting_hp` integer NOT NULL,
	`starting_temp_hp` integer NOT NULL,
	`armor_class` integer NOT NULL,
	`initiative_modifier` integer NOT NULL,
	`speed_ft` integer NOT NULL,
	`class_name` text,
	`level` integer,
	`passive_perception` integer,
	`initiative_total` integer,
	`initiative_roll` integer,
	`initiative_mode` text NOT NULL,
	`tie_rank` integer NOT NULL,
	`turn_policy` text NOT NULL,
	`exhaustion_level` integer NOT NULL,
	`notes` text NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`encounter_id`) REFERENCES `encounters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `combatant_templates`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "combatants_kind" CHECK("encounter_combatants"."kind" in ('player', 'enemy', 'npc')),
	CONSTRAINT "combatants_name" CHECK(length("encounter_combatants"."name") > 0),
	CONSTRAINT "combatants_max_hp" CHECK("encounter_combatants"."max_hp" between 1 and 1000000),
	CONSTRAINT "combatants_current_hp" CHECK("encounter_combatants"."current_hp" between 0 and "encounter_combatants"."max_hp"),
	CONSTRAINT "combatants_temp_hp" CHECK("encounter_combatants"."temp_hp" between 0 and 1000000),
	CONSTRAINT "combatants_starting_hp" CHECK("encounter_combatants"."starting_hp" between 0 and "encounter_combatants"."max_hp"),
	CONSTRAINT "combatants_starting_temp_hp" CHECK("encounter_combatants"."starting_temp_hp" between 0 and 1000000),
	CONSTRAINT "combatants_ac" CHECK("encounter_combatants"."armor_class" between 0 and 1000),
	CONSTRAINT "combatants_init_mod" CHECK("encounter_combatants"."initiative_modifier" between -1000 and 1000),
	CONSTRAINT "combatants_speed" CHECK("encounter_combatants"."speed_ft" between 0 and 1000000),
	CONSTRAINT "combatants_level" CHECK(("encounter_combatants"."level" is null or "encounter_combatants"."level" between 1 and 20)),
	CONSTRAINT "combatants_pp" CHECK(("encounter_combatants"."passive_perception" is null or "encounter_combatants"."passive_perception" between 0 and 1000)),
	CONSTRAINT "combatants_init_total" CHECK(("encounter_combatants"."initiative_total" is null or "encounter_combatants"."initiative_total" between -10000 and 10000)),
	CONSTRAINT "combatants_init_roll" CHECK(("encounter_combatants"."initiative_roll" is null or "encounter_combatants"."initiative_roll" between 1 and 20)),
	CONSTRAINT "combatants_init_mode" CHECK("encounter_combatants"."initiative_mode" in ('total', 'roll')),
	CONSTRAINT "combatants_tie_rank" CHECK("encounter_combatants"."tie_rank" >= 0),
	CONSTRAINT "combatants_turn_policy" CHECK("encounter_combatants"."turn_policy" in ('default', 'include', 'exclude')),
	CONSTRAINT "combatants_exhaustion" CHECK("encounter_combatants"."exhaustion_level" between 0 and 6)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `combatants_encounter_id` ON `encounter_combatants` (`encounter_id`,`id`);--> statement-breakpoint
CREATE INDEX `combatants_encounter_initiative` ON `encounter_combatants` (`encounter_id`,`initiative_total`,`tie_rank`);--> statement-breakpoint
CREATE TABLE `condition_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`encounter_id` text NOT NULL,
	`target_combatant_id` text NOT NULL,
	`condition_key` text NOT NULL,
	`source_combatant_id` text,
	`source_label` text NOT NULL,
	`notes` text NOT NULL,
	FOREIGN KEY (`encounter_id`) REFERENCES `encounters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`encounter_id`,`target_combatant_id`) REFERENCES `encounter_combatants`(`encounter_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`encounter_id`,`source_combatant_id`) REFERENCES `encounter_combatants`(`encounter_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conditions_key" CHECK("condition_applications"."condition_key" in ('blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'))
);
--> statement-breakpoint
CREATE INDEX `conditions_encounter_target` ON `condition_applications` (`encounter_id`,`target_combatant_id`);--> statement-breakpoint
CREATE INDEX `conditions_encounter_source` ON `condition_applications` (`encounter_id`,`source_combatant_id`);--> statement-breakpoint
CREATE TABLE `encounters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`round` integer NOT NULL,
	`active_combatant_id` text,
	`schedule_json` text NOT NULL,
	`last_turn_checkpoint_json` text,
	`rules_version` text NOT NULL,
	`skip_zero_hp_enemies` integer DEFAULT true NOT NULL,
	`version` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "encounters_name" CHECK(length("encounters"."name") > 0),
	CONSTRAINT "encounters_status" CHECK("encounters"."status" in ('draft', 'active', 'paused', 'completed')),
	CONSTRAINT "encounters_round" CHECK("encounters"."round" >= 0),
	CONSTRAINT "encounters_version" CHECK("encounters"."version" >= 1),
	CONSTRAINT "encounters_active_not_archived" CHECK(not ("encounters"."status" = 'active' and "encounters"."archived_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `encounters_one_active` ON `encounters` ((1)) WHERE "encounters"."status" = 'active';--> statement-breakpoint
CREATE INDEX `encounters_status_archived_updated` ON `encounters` (`status`,`archived_at`,`updated_at`);--> statement-breakpoint
CREATE TABLE `combatant_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`class_name` text,
	`level` integer,
	`max_hp` integer NOT NULL,
	`starting_hp` integer,
	`starting_temp_hp` integer DEFAULT 0 NOT NULL,
	`armor_class` integer NOT NULL,
	`initiative_modifier` integer NOT NULL,
	`speed_ft` integer NOT NULL,
	`passive_perception` integer,
	`notes` text DEFAULT '' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "templates_kind" CHECK("combatant_templates"."kind" in ('player', 'enemy', 'npc')),
	CONSTRAINT "templates_name" CHECK(length("combatant_templates"."name") > 0),
	CONSTRAINT "templates_level" CHECK(("combatant_templates"."level" is null or "combatant_templates"."level" between 1 and 20)),
	CONSTRAINT "templates_max_hp" CHECK("combatant_templates"."max_hp" between 1 and 1000000),
	CONSTRAINT "templates_starting_hp" CHECK(("combatant_templates"."starting_hp" is null or "combatant_templates"."starting_hp" between 0 and "combatant_templates"."max_hp")),
	CONSTRAINT "templates_starting_temp_hp" CHECK("combatant_templates"."starting_temp_hp" between 0 and 1000000),
	CONSTRAINT "templates_ac" CHECK("combatant_templates"."armor_class" between 0 and 1000),
	CONSTRAINT "templates_init_mod" CHECK("combatant_templates"."initiative_modifier" between -1000 and 1000),
	CONSTRAINT "templates_speed" CHECK("combatant_templates"."speed_ft" between 0 and 1000000),
	CONSTRAINT "templates_pp" CHECK(("combatant_templates"."passive_perception" is null or "combatant_templates"."passive_perception" between 0 and 1000))
);
--> statement-breakpoint
CREATE INDEX `templates_kind_archived` ON `combatant_templates` (`kind`,`archived_at`);--> statement-breakpoint
CREATE INDEX `templates_name` ON `combatant_templates` (`name`);