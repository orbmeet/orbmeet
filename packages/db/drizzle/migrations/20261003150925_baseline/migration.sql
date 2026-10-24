CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`linked_at` integer NOT NULL,
	CONSTRAINT `fk_accounts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL UNIQUE,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`transports` text,
	`name` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	CONSTRAINT `fk_passkeys_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "passkeys_credential_id_length_check" CHECK(length("credential_id") <= 1364),
	CONSTRAINT "passkeys_public_key_length_check" CHECK(length("public_key") <= 1024),
	CONSTRAINT "passkeys_device_type_check" CHECK("device_type" in ('singleDevice', 'multiDevice')),
	CONSTRAINT "passkeys_counter_nonnegative_check" CHECK("counter" >= 0),
	CONSTRAINT "passkeys_transports_json_check" CHECK("transports" IS NULL OR (json_valid("transports") AND json_type("transports") = 'array')),
	CONSTRAINT "passkeys_transports_length_check" CHECK("transports" IS NULL OR length("transports") <= 1024),
	CONSTRAINT "passkeys_last_used_after_created_check" CHECK("last_used_at" IS NULL OR "last_used_at" >= "created_at"),
	CONSTRAINT "passkeys_name_length_check" CHECK("name" IS NULL OR length("name") <= 120)
);
--> statement-breakpoint
CREATE TABLE `personal_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL UNIQUE,
	`token_prefix` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_personal_access_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "personal_access_tokens_name_length_check" CHECK(length("name") <= 100 AND length(trim("name")) BETWEEN 1 AND 100),
	CONSTRAINT "personal_access_tokens_hash_length_check" CHECK(length("token_hash") = 64),
	CONSTRAINT "personal_access_tokens_prefix_length_check" CHECK(length("token_prefix") <= 24 AND length(trim("token_prefix")) BETWEEN 1 AND 24),
	CONSTRAINT "personal_access_tokens_scopes_json_check" CHECK(json_valid("scopes") AND json_type("scopes") = 'array'),
	CONSTRAINT "personal_access_tokens_scopes_length_check" CHECK(length("scopes") <= 200),
	CONSTRAINT "personal_access_tokens_expiry_check" CHECK("expires_at" IS NULL OR "expires_at" >= "created_at"),
	CONSTRAINT "personal_access_tokens_last_used_check" CHECK("last_used_at" IS NULL OR "last_used_at" >= "created_at"),
	CONSTRAINT "personal_access_tokens_revoked_check" CHECK("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL UNIQUE,
	`previous_token_hash` text,
	`previous_token_expires_at` integer,
	`rotation_version` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "sessions_token_hash_length_check" CHECK(length("token_hash") = 64),
	CONSTRAINT "sessions_previous_token_hash_length_check" CHECK("previous_token_hash" IS NULL OR length("previous_token_hash") = 64),
	CONSTRAINT "sessions_previous_token_expiry_pair_check" CHECK(("previous_token_hash" IS NULL) = ("previous_token_expires_at" IS NULL)),
	CONSTRAINT "sessions_expires_after_created_check" CHECK("expires_at" >= "created_at"),
	CONSTRAINT "sessions_absolute_expires_after_expires_check" CHECK("absolute_expires_at" >= "expires_at"),
	CONSTRAINT "sessions_last_seen_after_created_check" CHECK("last_seen_at" IS NULL OR "last_seen_at" >= "created_at"),
	CONSTRAINT "sessions_ip_address_length_check" CHECK("ip_address" IS NULL OR length("ip_address") <= 64),
	CONSTRAINT "sessions_user_agent_length_check" CHECK("user_agent" IS NULL OR length("user_agent") <= 500)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`normalized_email` text NOT NULL UNIQUE,
	`image` text,
	`time_zone` text,
	`plan` text DEFAULT 'free' NOT NULL,
	`paddle_customer_id` text,
	`paddle_subscription_id` text,
	`subscription_status` text,
	`subscription_updated_at` integer,
	`deletion_started_at` integer,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "users_name_length_check" CHECK(length("name") <= 100 AND length(trim("name")) BETWEEN 1 AND 100),
	CONSTRAINT "users_email_length_check" CHECK(length("email") <= 320),
	CONSTRAINT "users_normalized_email_length_check" CHECK(length("normalized_email") <= 320),
	CONSTRAINT "users_image_length_check" CHECK("image" IS NULL OR length("image") <= 2048),
	CONSTRAINT "users_updated_after_created_check" CHECK("updated_at" >= "created_at"),
	CONSTRAINT "users_plan_check" CHECK("plan" in ('free', 'pro', 'organization')),
	CONSTRAINT "users_subscription_status_check" CHECK("subscription_status" IS NULL OR "subscription_status" in ('active', 'canceled', 'past_due', 'trialing', 'paused')),
	CONSTRAINT "users_role_check" CHECK("role" in ('admin', 'user'))
);
--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`data` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "verifications_type_check" CHECK("type" in ('otp_signup', 'otp_login', 'otp_account_delete', 'otp_step_up', 'otp_delivery', 'oauth_pkce', 'passkey_register', 'passkey_auth')),
	CONSTRAINT "verifications_data_json_check" CHECK("data" IS NULL OR json_valid("data")),
	CONSTRAINT "verifications_data_length_check" CHECK("data" IS NULL OR length("data") <= 32768),
	CONSTRAINT "verifications_expires_after_created_check" CHECK("expires_at" >= "created_at"),
	CONSTRAINT "verifications_updated_after_created_check" CHECK("updated_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`token_hash` text NOT NULL UNIQUE,
	`label` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_devices_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_devices_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "devices_token_hash_length_check" CHECK(length("token_hash") = 64),
	CONSTRAINT "devices_expires_after_created_check" CHECK("expires_at" >= "created_at"),
	CONSTRAINT "devices_last_seen_after_created_check" CHECK("last_seen_at" IS NULL OR "last_seen_at" >= "created_at"),
	CONSTRAINT "devices_label_length_check" CHECK("label" IS NULL OR length("label") <= 200)
);
--> statement-breakpoint
CREATE TABLE `organization_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` integer NOT NULL,
	CONSTRAINT `fk_organization_members_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_organization_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "organization_members_role_check" CHECK("role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE `organization_ownership_transfers` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`requested_by_user_id` text NOT NULL,
	`proposed_owner_user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_organization_ownership_transfers_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_organization_ownership_transfers_requested_by_user_id_users_id_fk` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_organization_ownership_transfers_proposed_owner_user_id_users_id_fk` FOREIGN KEY (`proposed_owner_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "organization_ownership_transfers_distinct_users_check" CHECK("requested_by_user_id" <> "proposed_owner_user_id"),
	CONSTRAINT "organization_ownership_transfers_expires_after_created_check" CHECK("expires_at" >= "created_at"),
	CONSTRAINT "organization_ownership_transfers_updated_after_created_check" CHECK("updated_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`plan` text DEFAULT 'organization' NOT NULL,
	`paddle_customer_id` text,
	`paddle_subscription_id` text,
	`subscription_status` text,
	`subscription_updated_at` integer,
	`license_limit` integer DEFAULT 25 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_organizations_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "organizations_name_length_check" CHECK(length("name") <= 200 AND length(trim("name")) BETWEEN 1 AND 200),
	CONSTRAINT "organizations_plan_check" CHECK("plan" in ('free', 'pro', 'organization')),
	CONSTRAINT "organizations_subscription_status_check" CHECK("subscription_status" IS NULL OR "subscription_status" in ('active', 'canceled', 'past_due', 'trialing', 'paused')),
	CONSTRAINT "organizations_license_limit_positive_check" CHECK("license_limit" > 0),
	CONSTRAINT "organizations_updated_after_created_check" CHECK("updated_at" >= "created_at"),
	CONSTRAINT "organizations_archived_after_created_check" CHECK("archived_at" IS NULL OR "archived_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'committed' NOT NULL,
	`r2_key` text NOT NULL UNIQUE,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`content_hash` text,
	`uploaded_by_id` text,
	`expires_at` integer,
	`committed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_files_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_files_uploaded_by_id_users_id_fk` FOREIGN KEY (`uploaded_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT "files_status_check" CHECK("status" in ('pending', 'committed', 'deleting')),
	CONSTRAINT "files_type_check" CHECK("type" in ('pdf', 'image')),
	CONSTRAINT "files_mime_type_check" CHECK("mime_type" in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "files_size_nonnegative_check" CHECK("size" >= 0),
	CONSTRAINT "files_content_hash_check" CHECK("content_hash" IS NULL OR length("content_hash") = 64),
	CONSTRAINT "files_filename_length_check" CHECK(length("filename") <= 255 AND length(trim("filename")) BETWEEN 1 AND 255),
	CONSTRAINT "files_r2_key_length_check" CHECK(length("r2_key") <= 512),
	CONSTRAINT "files_r2_key_check" CHECK(substr("r2_key", 1, 7) = 'spaces/'
        AND substr("r2_key", 8, length("space_id")) = "space_id"
        AND substr("r2_key", 8 + length("space_id"), 9) = '/uploads/'),
	CONSTRAINT "files_status_shape_check" CHECK((
        ("status" = 'pending' AND "expires_at" IS NOT NULL AND "committed_at" IS NULL)
        OR ("status" = 'committed' AND "expires_at" IS NULL AND "committed_at" IS NOT NULL)
        OR ("status" = 'deleting' AND "expires_at" IS NOT NULL)
      )),
	CONSTRAINT "files_expiry_after_created_check" CHECK("expires_at" IS NULL OR "expires_at" > "created_at"),
	CONSTRAINT "files_commit_after_created_check" CHECK("committed_at" IS NULL OR "committed_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE `space_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_space_audit_events_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_space_audit_events_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_space_audit_events_target_id_users_id_fk` FOREIGN KEY (`target_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT "space_audit_events_action_check" CHECK("action" in ('member_added', 'member_removed', 'member_left', 'role_changed', 'ownership_transferred', 'invite_created', 'invite_revoked', 'invite_downgraded', 'invite_rotated')),
	CONSTRAINT "space_audit_events_metadata_json_check" CHECK("metadata" IS NULL OR json_valid("metadata")),
	CONSTRAINT "space_audit_events_metadata_length_check" CHECK("metadata" IS NULL OR length("metadata") <= 32768)
);
--> statement-breakpoint
CREATE TABLE `space_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`token` text NOT NULL UNIQUE,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_space_invites_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_space_invites_created_by_id_users_id_fk` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT "space_invites_token_length_check" CHECK(length("token") = 8)
);
--> statement-breakpoint
CREATE TABLE `space_members` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` integer NOT NULL,
	CONSTRAINT `fk_space_members_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_space_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "space_members_role_check" CHECK("role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`owner_user_id` text,
	`organization_id` text,
	`slug` text,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_spaces_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_spaces_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "spaces_kind_check" CHECK("kind" in ('personal', 'shared')),
	CONSTRAINT "spaces_owner_shape_check" CHECK((
        ("owner_user_id" IS NOT NULL AND "organization_id" IS NULL)
        OR ("owner_user_id" IS NULL AND "organization_id" IS NOT NULL)
      )),
	CONSTRAINT "spaces_slug_shape_check" CHECK(("kind" = 'personal') = ("slug" IS NULL)),
	CONSTRAINT "spaces_personal_shape_check" CHECK("kind" = 'shared' OR (
        "owner_user_id" IS NOT NULL
        AND "archived_at" IS NULL
      )),
	CONSTRAINT "spaces_name_length_check" CHECK(length("name") <= 200 AND length(trim("name")) BETWEEN 1 AND 200),
	CONSTRAINT "spaces_description_length_check" CHECK("description" IS NULL OR length("description") <= 1000),
	CONSTRAINT "spaces_slug_length_check" CHECK("slug" IS NULL OR length("slug") <= 200),
	CONSTRAINT "spaces_time_zone_length_check" CHECK(length("time_zone") <= 100 AND length(trim("time_zone")) BETWEEN 1 AND 100),
	CONSTRAINT "spaces_updated_after_created_check" CHECK("updated_at" >= "created_at"),
	CONSTRAINT "spaces_archived_after_created_check" CHECK("archived_at" IS NULL OR "archived_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE `meeting_links` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL UNIQUE,
	`space_id` text NOT NULL,
	`space_kind` text NOT NULL,
	`reuse_policy` text DEFAULT 'one_time' NOT NULL,
	`spent_at` integer,
	`title` text,
	`allow_guests` integer DEFAULT false NOT NULL,
	`join_policy` text DEFAULT 'open' NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_links_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `meeting_links_space_kind_fk` FOREIGN KEY (`space_id`,`space_kind`) REFERENCES `spaces`(`id`,`kind`) ON DELETE CASCADE,
	CONSTRAINT "meeting_links_code_shape_check" CHECK(
    length("code") = 12
    AND substr("code", 4, 1) = '-'
    AND substr("code", 9, 1) = '-'
    AND lower("code") = "code"
    AND substr("code", 1, 1) BETWEEN 'a' AND 'z' AND substr("code", 2, 1) BETWEEN 'a' AND 'z' AND substr("code", 3, 1) BETWEEN 'a' AND 'z' AND substr("code", 5, 1) BETWEEN 'a' AND 'z' AND substr("code", 6, 1) BETWEEN 'a' AND 'z' AND substr("code", 7, 1) BETWEEN 'a' AND 'z' AND substr("code", 8, 1) BETWEEN 'a' AND 'z' AND substr("code", 10, 1) BETWEEN 'a' AND 'z' AND substr("code", 11, 1) BETWEEN 'a' AND 'z' AND substr("code", 12, 1) BETWEEN 'a' AND 'z'
  ),
	CONSTRAINT "meeting_links_space_kind_check" CHECK("space_kind" in ('personal', 'shared')),
	CONSTRAINT "meeting_links_reuse_policy_check" CHECK("reuse_policy" in ('reusable', 'one_time')),
	CONSTRAINT "meeting_links_join_policy_check" CHECK("join_policy" in ('open', 'approval_required', 'closed')),
	CONSTRAINT "meeting_links_guest_entry_check" CHECK("space_kind" = 'personal' OR "allow_guests" = 0),
	CONSTRAINT "meeting_links_spent_shape_check" CHECK("reuse_policy" = 'one_time' OR "spent_at" IS NULL),
	CONSTRAINT "meeting_links_title_length_check" CHECK("title" IS NULL OR length("title") <= 200),
	CONSTRAINT "meeting_links_expiry_after_created_check" CHECK("expires_at" IS NULL OR "expires_at" >= "created_at"),
	CONSTRAINT "meeting_links_last_used_after_created_check" CHECK("last_used_at" IS NULL OR "last_used_at" >= "created_at"),
	CONSTRAINT "meeting_links_last_used_before_expiry_check" CHECK("expires_at" IS NULL OR "last_used_at" IS NULL OR "last_used_at" <= "expires_at"),
	CONSTRAINT "meeting_links_spent_after_created_check" CHECK("spent_at" IS NULL OR "spent_at" >= "created_at"),
	CONSTRAINT "meeting_links_archived_after_created_check" CHECK("archived_at" IS NULL OR "archived_at" >= "created_at"),
	CONSTRAINT "meeting_links_updated_after_created_check" CHECK("updated_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE `space_default_meeting_links` (
	`space_id` text PRIMARY KEY NOT NULL,
	`space_kind` text NOT NULL,
	`meeting_link_id` text NOT NULL,
	`link_reuse_policy` text NOT NULL,
	CONSTRAINT `fk_space_default_meeting_links_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `space_default_meeting_links_space_kind_fk` FOREIGN KEY (`space_id`,`space_kind`) REFERENCES `spaces`(`id`,`kind`) ON DELETE CASCADE,
	CONSTRAINT `space_default_meeting_links_link_space_fk` FOREIGN KEY (`meeting_link_id`,`space_id`) REFERENCES `meeting_links`(`id`,`space_id`) ON DELETE CASCADE,
	CONSTRAINT `space_default_meeting_links_link_reuse_fk` FOREIGN KEY (`meeting_link_id`,`link_reuse_policy`) REFERENCES `meeting_links`(`id`,`reuse_policy`) ON DELETE CASCADE,
	CONSTRAINT "space_default_meeting_links_kind_check" CHECK("space_kind" = 'shared'),
	CONSTRAINT "space_default_meeting_links_reuse_check" CHECK("link_reuse_policy" = 'reusable')
);
--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`normalized_email` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`provider_code` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "email_suppressions_normalized_email_length_check" CHECK(length("normalized_email") <= 320),
	CONSTRAINT "email_suppressions_reason_check" CHECK("reason" in ('bounced', 'provider_suppressed', 'complained', 'unsubscribed')),
	CONSTRAINT "email_suppressions_provider_code_length_check" CHECK("provider_code" IS NULL OR length("provider_code") <= 64)
);
--> statement-breakpoint
CREATE TABLE `media_node_health` (
	`node_id` text PRIMARY KEY NOT NULL,
	`checked_at` integer NOT NULL,
	`failures` integer NOT NULL,
	`failing_since` integer,
	CONSTRAINT "media_node_health_node_id_length_check" CHECK(length("node_id") <= 64 AND length(trim("node_id")) BETWEEN 1 AND 64),
	CONSTRAINT "media_node_health_failures_check" CHECK("failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE `meeting_admissions` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_user_id` text,
	`guest_secret_hash` text,
	`display_name` text NOT NULL,
	`admission_status` text DEFAULT 'pending' NOT NULL,
	`decision_reason` text,
	`decided_by_user_id` text,
	`decided_at` integer,
	`screen_share_granted` integer DEFAULT false NOT NULL,
	`meeting_moderator` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_admissions_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_admissions_subject_user_id_users_id_fk` FOREIGN KEY (`subject_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_admissions_decided_by_user_id_users_id_fk` FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT "meeting_admissions_subject_type_check" CHECK("subject_type" in ('user', 'guest')),
	CONSTRAINT "meeting_admissions_status_check" CHECK("admission_status" in ('pending', 'approved', 'denied', 'revoked', 'expired')),
	CONSTRAINT "meeting_admissions_subject_shape_check" CHECK((
        ("subject_type" = 'user' AND "subject_user_id" IS NOT NULL AND "guest_secret_hash" IS NULL)
        OR (
          "subject_type" = 'guest'
          AND "subject_user_id" IS NULL
          AND (
            "guest_secret_hash" IS NOT NULL
            OR "admission_status" IN ('denied', 'revoked', 'expired')
          )
        )
      )),
	CONSTRAINT "meeting_admissions_decision_shape_check" CHECK((
        ("admission_status" = 'approved' AND "decided_at" IS NOT NULL)
        OR (
          "admission_status" IN ('denied', 'revoked', 'expired')
          AND "screen_share_granted" = 0
          AND "meeting_moderator" = 0
          AND "decided_at" IS NOT NULL
        )
        OR (
          "admission_status" = 'pending'
          AND "screen_share_granted" = 0
          AND "meeting_moderator" = 0
          AND "decision_reason" IS NULL
          AND "decided_by_user_id" IS NULL
          AND "decided_at" IS NULL
        )
      )),
	CONSTRAINT "meeting_admissions_timestamps_check" CHECK((
        "updated_at" >= "created_at"
        AND ("decided_at" IS NULL OR "decided_at" >= "created_at")
      )),
	CONSTRAINT "meeting_admissions_display_name_length_check" CHECK(length("display_name") <= 100 AND length(trim("display_name")) BETWEEN 1 AND 100),
	CONSTRAINT "meeting_admissions_guest_secret_hash_length_check" CHECK("guest_secret_hash" IS NULL OR length("guest_secret_hash") <= 255),
	CONSTRAINT "meeting_admissions_decision_reason_length_check" CHECK("decision_reason" IS NULL OR length("decision_reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE `meeting_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`admission_id` text NOT NULL,
	`livekit_identity` text NOT NULL,
	`livekit_participant_sid` text,
	`user_id` text,
	`role` text NOT NULL,
	`connection_status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`token_issued_at` integer NOT NULL,
	`connected_at` integer,
	`disconnected_at` integer,
	`last_webhook_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_connections_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_connections_admission_id_meeting_admissions_id_fk` FOREIGN KEY (`admission_id`) REFERENCES `meeting_admissions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_connections_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `meeting_connections_admission_meeting_fk` FOREIGN KEY (`admission_id`,`meeting_id`) REFERENCES `meeting_admissions`(`id`,`meeting_id`) ON DELETE CASCADE,
	CONSTRAINT "meeting_connections_role_check" CHECK("role" in ('host', 'moderator', 'attendee')),
	CONSTRAINT "meeting_connections_status_check" CHECK("connection_status" in ('pending', 'live', 'ended')),
	CONSTRAINT "meeting_connections_timestamp_shape_check" CHECK((
        "connected_at" IS NULL OR "connected_at" >= "token_issued_at"
      ) AND (
        "disconnected_at" IS NULL OR "disconnected_at" >= "token_issued_at"
      ) AND (
        "connected_at" IS NULL OR "disconnected_at" IS NULL OR "disconnected_at" >= "connected_at"
      ) AND (
        "last_webhook_at" IS NULL OR "last_webhook_at" >= "token_issued_at"
      ) AND "updated_at" >= "created_at"),
	CONSTRAINT "meeting_connections_status_timestamp_shape_check" CHECK((
        ("connection_status" = 'pending' AND "connected_at" IS NULL AND "disconnected_at" IS NULL)
        OR ("connection_status" = 'live' AND "connected_at" IS NOT NULL AND "disconnected_at" IS NULL)
        OR ("connection_status" = 'ended' AND "disconnected_at" IS NOT NULL)
      )),
	CONSTRAINT "meeting_connections_livekit_identity_length_check" CHECK(length("livekit_identity") <= 200 AND length(trim("livekit_identity")) BETWEEN 1 AND 200),
	CONSTRAINT "meeting_connections_livekit_sid_length_check" CHECK("livekit_participant_sid" IS NULL OR length("livekit_participant_sid") <= 200),
	CONSTRAINT "meeting_connections_reason_length_check" CHECK("reason" IS NULL OR length("reason") <= 200)
);
--> statement-breakpoint
CREATE TABLE `meeting_schedule_attendees` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`user_id` text,
	`email` text NOT NULL,
	`normalized_email` text NOT NULL,
	`display_name` text,
	`invited_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_schedule_attendees_schedule_id_meeting_schedules_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `meeting_schedules`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_schedule_attendees_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT "meeting_schedule_attendees_email_length_check" CHECK(length("email") <= 320),
	CONSTRAINT "meeting_schedule_attendees_normalized_email_length_check" CHECK(length("normalized_email") <= 320),
	CONSTRAINT "meeting_schedule_attendees_display_name_length_check" CHECK("display_name" IS NULL OR length("display_name") <= 100)
);
--> statement-breakpoint
CREATE TABLE `meeting_schedule_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`attendee_id` text NOT NULL,
	`kind` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`delivery_started_at` integer,
	`sent_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_schedule_notifications_schedule_id_meeting_schedules_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `meeting_schedules`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_schedule_notifications_attendee_id_meeting_schedule_attendees_id_fk` FOREIGN KEY (`attendee_id`) REFERENCES `meeting_schedule_attendees`(`id`) ON DELETE CASCADE,
	CONSTRAINT `meeting_schedule_notifications_attendee_schedule_fk` FOREIGN KEY (`attendee_id`,`schedule_id`) REFERENCES `meeting_schedule_attendees`(`id`,`schedule_id`) ON DELETE CASCADE,
	CONSTRAINT "meeting_schedule_notifications_kind_check" CHECK("kind" in ('invitation', 'reminder', 'rescheduled', 'canceled')),
	CONSTRAINT "meeting_schedule_notifications_status_check" CHECK("status" in ('pending', 'sent', 'failed')),
	CONSTRAINT "meeting_schedule_notifications_revision_positive_check" CHECK("revision" > 0),
	CONSTRAINT "meeting_schedule_notifications_attempts_nonnegative_check" CHECK("attempts" >= 0),
	CONSTRAINT "meeting_schedule_notifications_sent_shape_check" CHECK((
        ("status" IN ('pending', 'failed') AND "sent_at" IS NULL)
        OR ("status" = 'sent' AND "sent_at" IS NOT NULL)
      )),
	CONSTRAINT "meeting_schedule_notifications_last_error_length_check" CHECK("last_error" IS NULL OR length("last_error") <= 1000)
);
--> statement-breakpoint
CREATE TABLE `meeting_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_link_id` text NOT NULL,
	`meeting_id` text UNIQUE,
	`organizer_user_id` text NOT NULL,
	`space_id` text NOT NULL,
	`title` text,
	`join_policy` text DEFAULT 'open' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`time_zone` text NOT NULL,
	`reminder_minutes_before` integer,
	`idempotency_key` text,
	`idempotency_fingerprint` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`write_token` text,
	`canceled_at` integer,
	`canceled_by_user_id` text,
	`cancel_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_schedules_meeting_link_id_meeting_links_id_fk` FOREIGN KEY (`meeting_link_id`) REFERENCES `meeting_links`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_schedules_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_meeting_schedules_organizer_user_id_users_id_fk` FOREIGN KEY (`organizer_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_schedules_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_schedules_canceled_by_user_id_users_id_fk` FOREIGN KEY (`canceled_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT `meeting_schedules_link_space_fk` FOREIGN KEY (`meeting_link_id`,`space_id`) REFERENCES `meeting_links`(`id`,`space_id`) ON DELETE CASCADE,
	CONSTRAINT "meeting_schedules_title_length_check" CHECK("title" IS NULL OR length("title") <= 200),
	CONSTRAINT "meeting_schedules_join_policy_check" CHECK("join_policy" in ('open', 'approval_required', 'closed')),
	CONSTRAINT "meeting_schedules_time_zone_length_check" CHECK(length("time_zone") <= 100 AND length(trim("time_zone")) BETWEEN 1 AND 100),
	CONSTRAINT "meeting_schedules_reminder_minutes_check" CHECK("reminder_minutes_before" IS NULL OR ("reminder_minutes_before" >= 5 AND "reminder_minutes_before" <= 10080)),
	CONSTRAINT "meeting_schedules_idempotency_key_length_check" CHECK("idempotency_key" IS NULL OR length("idempotency_key") <= 128),
	CONSTRAINT "meeting_schedules_idempotency_fingerprint_check" CHECK("idempotency_fingerprint" IS NULL OR (
        "idempotency_key" IS NOT NULL
        AND length("idempotency_fingerprint") = 64
        AND "idempotency_fingerprint" NOT GLOB '*[^0-9a-f]*'
      )),
	CONSTRAINT "meeting_schedules_revision_positive_check" CHECK("revision" > 0),
	CONSTRAINT "meeting_schedules_ends_after_starts_check" CHECK("ends_at" > "starts_at"),
	CONSTRAINT "meeting_schedules_updated_after_created_check" CHECK("updated_at" >= "created_at"),
	CONSTRAINT "meeting_schedules_cancel_shape_check" CHECK((
        ("canceled_at" IS NULL AND "canceled_by_user_id" IS NULL AND "cancel_reason" IS NULL)
        OR ("canceled_at" IS NOT NULL)
      )),
	CONSTRAINT "meeting_schedules_cancel_reason_length_check" CHECK("cancel_reason" IS NULL OR length("cancel_reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE `meeting_whiteboard_surfaces` (
	`meeting_id` text PRIMARY KEY NOT NULL,
	`open` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_whiteboard_surfaces_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE CASCADE,
	CONSTRAINT "meeting_whiteboard_surfaces_revision_nonnegative_check" CHECK("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_link_id` text NOT NULL,
	`title` text,
	`started_by_user_id` text,
	`space_id` text NOT NULL,
	`space_kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`allow_guests` integer DEFAULT false NOT NULL,
	`recording_enabled` integer DEFAULT false NOT NULL,
	`join_policy` text DEFAULT 'open' NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`retain_until` integer,
	`billing_principal_type` text NOT NULL,
	`billing_principal_id` text NOT NULL,
	`billing_plan` text NOT NULL,
	`media_node_id` text,
	`active_egress_id` text,
	`active_stream_egress_id` text,
	`egress_state_revision` integer DEFAULT 0 NOT NULL,
	`first_joined_at` integer,
	`drained_at` integer,
	`closing_at` integer,
	`closing_whiteboard_id` text,
	`closing_command_id` text,
	`summary_status` text,
	`summary_request_seq` integer DEFAULT 0 NOT NULL,
	`end_reason` text,
	`transcript_segment_count` integer DEFAULT 0 NOT NULL,
	`transcript_last_ingested_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meetings_meeting_link_id_meeting_links_id_fk` FOREIGN KEY (`meeting_link_id`) REFERENCES `meeting_links`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_meetings_started_by_user_id_users_id_fk` FOREIGN KEY (`started_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_meetings_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `meetings_link_space_fk` FOREIGN KEY (`meeting_link_id`,`space_id`) REFERENCES `meeting_links`(`id`,`space_id`),
	CONSTRAINT `meetings_space_kind_fk` FOREIGN KEY (`space_id`,`space_kind`) REFERENCES `spaces`(`id`,`kind`),
	CONSTRAINT "meetings_space_kind_check" CHECK("space_kind" in ('personal', 'shared')),
	CONSTRAINT "meetings_title_length_check" CHECK("title" IS NULL OR length("title") <= 200),
	CONSTRAINT "meetings_status_check" CHECK("status" in ('open', 'ended')),
	CONSTRAINT "meetings_join_policy_check" CHECK("join_policy" in ('open', 'approval_required', 'closed')),
	CONSTRAINT "meetings_guest_entry_check" CHECK("space_kind" = 'personal' OR "allow_guests" = 0),
	CONSTRAINT "meetings_billing_principal_type_check" CHECK("billing_principal_type" in ('user', 'organization')),
	CONSTRAINT "meetings_billing_principal_id_length_check" CHECK(length("billing_principal_id") <= 255 AND length(trim("billing_principal_id")) BETWEEN 1 AND 255),
	CONSTRAINT "meetings_billing_plan_check" CHECK("billing_plan" in ('free', 'pro', 'organization')),
	CONSTRAINT "meetings_lifecycle_check" CHECK((
        ("status" = 'open' AND "ended_at" IS NULL)
        OR ("status" = 'ended' AND "ended_at" IS NOT NULL)
      )),
	CONSTRAINT "meetings_ended_after_started_check" CHECK("ended_at" IS NULL OR "ended_at" >= "started_at"),
	CONSTRAINT "meetings_retain_after_end_check" CHECK("retain_until" IS NULL OR ("ended_at" IS NOT NULL AND "retain_until" >= "ended_at")),
	CONSTRAINT "meetings_updated_after_started_check" CHECK("updated_at" >= "started_at"),
	CONSTRAINT "meetings_ended_egress_cleared_check" CHECK("status" = 'open' OR "active_egress_id" IS NULL),
	CONSTRAINT "meetings_ended_stream_egress_cleared_check" CHECK("status" = 'open' OR "active_stream_egress_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE `user_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`contact_user_id` text,
	`email` text,
	`normalized_email` text,
	`display_name` text NOT NULL,
	`source` text NOT NULL,
	`first_met_at` integer,
	`last_met_at` integer,
	`meeting_count` integer DEFAULT 0 NOT NULL,
	`last_meeting_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_user_contacts_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_user_contacts_contact_user_id_users_id_fk` FOREIGN KEY (`contact_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_user_contacts_last_meeting_id_meetings_id_fk` FOREIGN KEY (`last_meeting_id`) REFERENCES `meetings`(`id`) ON DELETE SET NULL,
	CONSTRAINT "user_contacts_email_length_check" CHECK("email" IS NULL OR length("email") <= 320),
	CONSTRAINT "user_contacts_normalized_email_length_check" CHECK("normalized_email" IS NULL OR length("normalized_email") <= 320),
	CONSTRAINT "user_contacts_identity_check" CHECK("contact_user_id" IS NOT NULL OR "normalized_email" IS NOT NULL),
	CONSTRAINT "user_contacts_display_name_length_check" CHECK(length("display_name") <= 100 AND length(trim("display_name")) BETWEEN 1 AND 100),
	CONSTRAINT "user_contacts_source_check" CHECK("source" in ('meeting', 'invitation', 'manual')),
	CONSTRAINT "user_contacts_meeting_count_check" CHECK("meeting_count" >= 0),
	CONSTRAINT "user_contacts_meeting_time_shape_check" CHECK((
        ("first_met_at" IS NULL AND "last_met_at" IS NULL AND "meeting_count" = 0)
        OR (
          "first_met_at" IS NOT NULL
          AND "last_met_at" IS NOT NULL
          AND "meeting_count" > 0
          AND "last_met_at" >= "first_met_at"
        )
      )),
	CONSTRAINT "user_contacts_updated_after_created_check" CHECK("updated_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE `transcripts` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`admission_id` text,
	`connection_id` text,
	`participant_identity` text NOT NULL,
	`participant_name` text NOT NULL,
	`text` text NOT NULL,
	`segment_id` text NOT NULL,
	`language` text,
	`speaker_id` text,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_transcripts_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_transcripts_admission_id_meeting_admissions_id_fk` FOREIGN KEY (`admission_id`) REFERENCES `meeting_admissions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_transcripts_connection_id_meeting_connections_id_fk` FOREIGN KEY (`connection_id`) REFERENCES `meeting_connections`(`id`) ON DELETE SET NULL,
	CONSTRAINT `transcripts_admission_meeting_fk` FOREIGN KEY (`admission_id`,`meeting_id`) REFERENCES `meeting_admissions`(`id`,`meeting_id`),
	CONSTRAINT `transcripts_connection_meeting_fk` FOREIGN KEY (`connection_id`,`meeting_id`) REFERENCES `meeting_connections`(`id`,`meeting_id`),
	CONSTRAINT "transcripts_updated_after_started_check" CHECK("updated_at" >= "started_at" / 1000),
	CONSTRAINT "transcripts_participant_identity_length_check" CHECK(length("participant_identity") <= 200 AND length(trim("participant_identity")) BETWEEN 1 AND 200),
	CONSTRAINT "transcripts_participant_name_length_check" CHECK(length("participant_name") <= 100 AND length(trim("participant_name")) BETWEEN 1 AND 100),
	CONSTRAINT "transcripts_text_length_check" CHECK(length("text") <= 32768 AND length(trim("text")) BETWEEN 1 AND 32768),
	CONSTRAINT "transcripts_segment_id_length_check" CHECK(length("segment_id") <= 255 AND length(trim("segment_id")) BETWEEN 1 AND 255),
	CONSTRAINT "transcripts_language_length_check" CHECK("language" IS NULL OR length("language") <= 35),
	CONSTRAINT "transcripts_speaker_id_length_check" CHECK("speaker_id" IS NULL OR length("speaker_id") <= 200)
);
--> statement-breakpoint
CREATE TABLE `meeting_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`summary` text NOT NULL,
	`duration_seconds` integer,
	`participant_count` integer,
	`transcribed_participant_count` integer,
	`transcript_segment_count` integer DEFAULT 0 NOT NULL,
	`transcript_last_updated_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_summaries_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE CASCADE,
	CONSTRAINT "meeting_summaries_duration_nonnegative_check" CHECK("duration_seconds" IS NULL OR "duration_seconds" >= 0),
	CONSTRAINT "meeting_summaries_participant_count_nonnegative_check" CHECK("participant_count" IS NULL OR "participant_count" >= 0),
	CONSTRAINT "meeting_summaries_transcribed_participant_count_nonnegative_check" CHECK("transcribed_participant_count" IS NULL OR "transcribed_participant_count" >= 0),
	CONSTRAINT "meeting_summaries_transcript_segment_count_nonnegative_check" CHECK("transcript_segment_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `meeting_whiteboard_pages` (
	`meeting_whiteboard_id` text NOT NULL,
	`page_id` text NOT NULL,
	`first_presented_at` integer,
	`first_edited_at` integer,
	`handout_order` integer,
	CONSTRAINT `fk_meeting_whiteboard_pages_meeting_whiteboard_id_meeting_whiteboards_id_fk` FOREIGN KEY (`meeting_whiteboard_id`) REFERENCES `meeting_whiteboards`(`id`) ON DELETE CASCADE,
	CONSTRAINT "meeting_whiteboard_pages_page_id_length_check" CHECK(length("page_id") <= 128 AND length(trim("page_id")) BETWEEN 1 AND 128),
	CONSTRAINT "meeting_whiteboard_pages_handout_order_nonnegative_check" CHECK("handout_order" IS NULL OR "handout_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE `meeting_whiteboards` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`space_id` text NOT NULL,
	`whiteboard_id` text NOT NULL,
	`title_at_use` text,
	`title_at_end` text,
	`start_revision_id` text,
	`start_snapshot_hash` text,
	`last_shared_snapshot_r2_key` text,
	`last_shared_snapshot_hash` text,
	`last_shared_document_clock` integer,
	`last_shared_snapshot_size` integer,
	`last_shared_at` integer,
	`allow_participant_copy` integer DEFAULT true NOT NULL,
	`captured_revision_id` text,
	`capture_status` text DEFAULT 'live' NOT NULL,
	`capture_failure_reason` text,
	`attached_at` integer NOT NULL,
	`last_presented_at` integer,
	`focused_at` integer,
	`captured_at` integer,
	CONSTRAINT `fk_meeting_whiteboards_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_whiteboards_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_whiteboards_whiteboard_id_whiteboards_id_fk` FOREIGN KEY (`whiteboard_id`) REFERENCES `whiteboards`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_meeting_whiteboards_start_revision_id_whiteboard_revisions_id_fk` FOREIGN KEY (`start_revision_id`) REFERENCES `whiteboard_revisions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_meeting_whiteboards_captured_revision_id_whiteboard_revisions_id_fk` FOREIGN KEY (`captured_revision_id`) REFERENCES `whiteboard_revisions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `meeting_whiteboards_meeting_space_fk` FOREIGN KEY (`meeting_id`,`space_id`) REFERENCES `meetings`(`id`,`space_id`) ON DELETE CASCADE,
	CONSTRAINT `meeting_whiteboards_whiteboard_space_fk` FOREIGN KEY (`whiteboard_id`,`space_id`) REFERENCES `whiteboards`(`id`,`space_id`) ON DELETE RESTRICT,
	CONSTRAINT "meeting_whiteboards_title_at_use_length_check" CHECK("title_at_use" IS NULL OR length("title_at_use") <= 200),
	CONSTRAINT "meeting_whiteboards_title_at_end_length_check" CHECK("title_at_end" IS NULL OR length("title_at_end") <= 200),
	CONSTRAINT "meeting_whiteboards_start_hash_check" CHECK("start_snapshot_hash" IS NULL OR length("start_snapshot_hash") = 32),
	CONSTRAINT "meeting_whiteboards_last_shared_hash_check" CHECK("last_shared_snapshot_hash" IS NULL OR length("last_shared_snapshot_hash") = 32),
	CONSTRAINT "meeting_whiteboards_last_shared_clock_nonnegative_check" CHECK("last_shared_document_clock" IS NULL OR "last_shared_document_clock" >= 0),
	CONSTRAINT "meeting_whiteboards_last_shared_size_nonnegative_check" CHECK("last_shared_snapshot_size" IS NULL OR "last_shared_snapshot_size" >= 0),
	CONSTRAINT "meeting_whiteboards_last_shared_shape_check" CHECK((
        ("last_shared_snapshot_r2_key" IS NULL
          AND "last_shared_snapshot_hash" IS NULL
          AND "last_shared_document_clock" IS NULL
          AND "last_shared_snapshot_size" IS NULL
          AND "last_shared_at" IS NULL)
        OR ("last_shared_snapshot_r2_key" IS NOT NULL
          AND "last_shared_snapshot_hash" IS NOT NULL
          AND "last_shared_snapshot_size" IS NOT NULL
          AND "last_shared_at" IS NOT NULL)
      )),
	CONSTRAINT "meeting_whiteboards_last_shared_key_check" CHECK("last_shared_snapshot_r2_key" IS NULL OR (
        substr("last_shared_snapshot_r2_key", 1, 18) = 'internal/meetings/'
        AND instr("last_shared_snapshot_r2_key", '/canvases/') > 18
      )),
	CONSTRAINT "meeting_whiteboards_capture_status_check" CHECK("capture_status" in ('live', 'capturing', 'captured', 'failed')),
	CONSTRAINT "meeting_whiteboards_failure_reason_length_check" CHECK("capture_failure_reason" IS NULL OR length("capture_failure_reason") <= 1000),
	CONSTRAINT "meeting_whiteboards_capture_shape_check" CHECK((
        ("capture_status" IN ('live', 'capturing') AND "captured_at" IS NULL AND "captured_revision_id" IS NULL)
        OR ("capture_status" = 'captured' AND "captured_at" IS NOT NULL AND "captured_revision_id" IS NOT NULL AND "capture_failure_reason" IS NULL)
        OR ("capture_status" = 'failed' AND "captured_at" IS NULL AND "captured_revision_id" IS NULL AND "capture_failure_reason" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE `operation_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "operation_leases_id_length_check" CHECK(length("id") <= 200 AND length(trim("id")) BETWEEN 1 AND 200),
	CONSTRAINT "operation_leases_owner_token_length_check" CHECK(length("owner_token") <= 100 AND length(trim("owner_token")) BETWEEN 1 AND 100),
	CONSTRAINT "operation_leases_expiry_check" CHECK("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE TABLE `upload_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`principal` text NOT NULL,
	`scope` text NOT NULL,
	`bytes` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "upload_reservations_principal_length_check" CHECK(length("principal") <= 255 AND length(trim("principal")) BETWEEN 1 AND 255),
	CONSTRAINT "upload_reservations_scope_length_check" CHECK(length("scope") <= 255 AND length(trim("scope")) BETWEEN 1 AND 255),
	CONSTRAINT "upload_reservations_bytes_positive_check" CHECK("bytes" > 0),
	CONSTRAINT "upload_reservations_expires_after_created_check" CHECK("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE TABLE `whiteboard_ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`principal` text NOT NULL,
	`usage_day` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`reserved_output_tokens` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "whiteboard_ai_usage_request_count_nonnegative_check" CHECK("request_count" >= 0),
	CONSTRAINT "whiteboard_ai_usage_reserved_tokens_nonnegative_check" CHECK("reserved_output_tokens" >= 0),
	CONSTRAINT "whiteboard_ai_usage_principal_length_check" CHECK(length("principal") <= 255 AND length(trim("principal")) BETWEEN 1 AND 255),
	CONSTRAINT "whiteboard_ai_usage_day_length_check" CHECK(length("usage_day") = 10)
);
--> statement-breakpoint
CREATE TABLE `whiteboard_asset_references` (
	`id` text PRIMARY KEY NOT NULL,
	`whiteboard_id` text NOT NULL,
	`source_whiteboard_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_whiteboard_asset_references_whiteboard_id_whiteboards_id_fk` FOREIGN KEY (`whiteboard_id`) REFERENCES `whiteboards`(`id`) ON DELETE CASCADE,
	CONSTRAINT "whiteboard_asset_references_different_board_check" CHECK("whiteboard_id" <> "source_whiteboard_id"),
	CONSTRAINT "whiteboard_asset_references_r2_key_check" CHECK(substr("r2_key", 1, 12) = 'whiteboards/'
        AND instr("r2_key", '/assets/') > 12)
);
--> statement-breakpoint
CREATE TABLE `whiteboard_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`whiteboard_id` text NOT NULL,
	`space_id` text NOT NULL,
	`r2_key` text NOT NULL UNIQUE,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`uploaded_by_user_id` text,
	`guest_admission_id` text,
	`expires_at` integer,
	`committed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_whiteboard_assets_whiteboard_id_whiteboards_id_fk` FOREIGN KEY (`whiteboard_id`) REFERENCES `whiteboards`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboard_assets_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboard_assets_uploaded_by_user_id_users_id_fk` FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_whiteboard_assets_guest_admission_id_meeting_admissions_id_fk` FOREIGN KEY (`guest_admission_id`) REFERENCES `meeting_admissions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `whiteboard_assets_board_space_fk` FOREIGN KEY (`whiteboard_id`,`space_id`) REFERENCES `whiteboards`(`id`,`space_id`) ON DELETE CASCADE,
	CONSTRAINT "whiteboard_assets_status_check" CHECK("status" in ('pending', 'committed', 'deleting')),
	CONSTRAINT "whiteboard_assets_size_nonnegative_check" CHECK("size" >= 0),
	CONSTRAINT "whiteboard_assets_filename_length_check" CHECK(length("filename") <= 255 AND length(trim("filename")) BETWEEN 1 AND 255),
	CONSTRAINT "whiteboard_assets_mime_type_length_check" CHECK(length("mime_type") <= 100 AND length(trim("mime_type")) BETWEEN 1 AND 100),
	CONSTRAINT "whiteboard_assets_r2_key_length_check" CHECK(length("r2_key") <= 512),
	CONSTRAINT "whiteboard_assets_r2_key_check" CHECK(substr("r2_key", 1, 12) = 'whiteboards/'
        AND substr("r2_key", 13, length("whiteboard_id")) = "whiteboard_id"
        AND substr("r2_key", 13 + length("whiteboard_id"), 8) = '/assets/'),
	CONSTRAINT "whiteboard_assets_status_shape_check" CHECK((
        ("status" = 'pending' AND "expires_at" IS NOT NULL AND "committed_at" IS NULL)
        OR ("status" = 'committed' AND "expires_at" IS NULL AND "committed_at" IS NOT NULL)
        OR ("status" = 'deleting' AND "expires_at" IS NOT NULL)
      )),
	CONSTRAINT "whiteboard_assets_uploader_shape_check" CHECK(NOT ("uploaded_by_user_id" IS NOT NULL AND "guest_admission_id" IS NOT NULL)),
	CONSTRAINT "whiteboard_assets_expiry_after_created_check" CHECK("expires_at" IS NULL OR "expires_at" > "created_at"),
	CONSTRAINT "whiteboard_assets_commit_after_created_check" CHECK("committed_at" IS NULL OR "committed_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE `whiteboard_edit_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`whiteboard_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`meeting_whiteboard_id` text NOT NULL,
	`user_id` text,
	`admission_id` text,
	`granted_by_user_id` text,
	`granted_at` integer NOT NULL,
	`revoked_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_whiteboard_edit_grants_whiteboard_id_whiteboards_id_fk` FOREIGN KEY (`whiteboard_id`) REFERENCES `whiteboards`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboard_edit_grants_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboard_edit_grants_meeting_whiteboard_id_meeting_whiteboards_id_fk` FOREIGN KEY (`meeting_whiteboard_id`) REFERENCES `meeting_whiteboards`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboard_edit_grants_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboard_edit_grants_admission_id_meeting_admissions_id_fk` FOREIGN KEY (`admission_id`) REFERENCES `meeting_admissions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboard_edit_grants_granted_by_user_id_users_id_fk` FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT `whiteboard_edit_grants_usage_meeting_fk` FOREIGN KEY (`meeting_whiteboard_id`,`meeting_id`,`whiteboard_id`) REFERENCES `meeting_whiteboards`(`id`,`meeting_id`,`whiteboard_id`) ON DELETE CASCADE,
	CONSTRAINT "whiteboard_edit_grants_principal_shape_check" CHECK((
        ("user_id" IS NOT NULL AND "admission_id" IS NULL)
        OR ("user_id" IS NULL AND "admission_id" IS NOT NULL)
      )),
	CONSTRAINT "whiteboard_edit_grants_revoked_after_granted_check" CHECK("revoked_at" IS NULL OR "revoked_at" >= "granted_at")
);
--> statement-breakpoint
CREATE TABLE `whiteboard_file_references` (
	`whiteboard_id` text NOT NULL,
	`file_id` text NOT NULL,
	`space_id` text NOT NULL,
	`role` text DEFAULT 'source' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `whiteboard_file_references_pk` PRIMARY KEY(`whiteboard_id`, `file_id`),
	CONSTRAINT `fk_whiteboard_file_references_whiteboard_id_whiteboards_id_fk` FOREIGN KEY (`whiteboard_id`) REFERENCES `whiteboards`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboard_file_references_file_id_files_id_fk` FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboard_file_references_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `whiteboard_file_references_whiteboard_space_fk` FOREIGN KEY (`whiteboard_id`,`space_id`) REFERENCES `whiteboards`(`id`,`space_id`) ON DELETE CASCADE,
	CONSTRAINT `whiteboard_file_references_file_space_fk` FOREIGN KEY (`file_id`,`space_id`) REFERENCES `files`(`id`,`space_id`) ON DELETE CASCADE,
	CONSTRAINT "whiteboard_file_references_role_check" CHECK("role" in ('source', 'attachment'))
);
--> statement-breakpoint
CREATE TABLE `whiteboard_revision_asset_references` (
	`revision_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `whiteboard_revision_asset_references_pk` PRIMARY KEY(`revision_id`, `r2_key`),
	CONSTRAINT `fk_whiteboard_revision_asset_references_revision_id_whiteboard_revisions_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `whiteboard_revisions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "whiteboard_revision_asset_references_r2_key_check" CHECK(substr("r2_key", 1, 12) = 'whiteboards/'
        AND instr("r2_key", '/assets/') > 12)
);
--> statement-breakpoint
CREATE TABLE `whiteboard_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`whiteboard_id` text NOT NULL,
	`space_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`kind` text NOT NULL,
	`source_meeting_id` text,
	`snapshot_r2_key` text NOT NULL UNIQUE,
	`snapshot_hash` text,
	`asset_manifest` text,
	`document_clock` integer,
	`snapshot_size` integer NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_whiteboard_revisions_whiteboard_id_whiteboards_id_fk` FOREIGN KEY (`whiteboard_id`) REFERENCES `whiteboards`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboard_revisions_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboard_revisions_source_meeting_id_meetings_id_fk` FOREIGN KEY (`source_meeting_id`) REFERENCES `meetings`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_whiteboard_revisions_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT `whiteboard_revisions_board_space_fk` FOREIGN KEY (`whiteboard_id`,`space_id`) REFERENCES `whiteboards`(`id`,`space_id`) ON DELETE CASCADE,
	CONSTRAINT "whiteboard_revisions_number_positive_check" CHECK("revision_number" > 0),
	CONSTRAINT "whiteboard_revisions_kind_check" CHECK("kind" in ('checkpoint', 'meeting_end', 'manual', 'pre_restore')),
	CONSTRAINT "whiteboard_revisions_hash_check" CHECK("snapshot_hash" IS NULL OR length("snapshot_hash") = 32),
	CONSTRAINT "whiteboard_revisions_asset_manifest_json_check" CHECK("asset_manifest" IS NULL OR (json_valid("asset_manifest") AND json_type("asset_manifest") = 'array')),
	CONSTRAINT "whiteboard_revisions_asset_manifest_length_check" CHECK("asset_manifest" IS NULL OR length("asset_manifest") <= 32768),
	CONSTRAINT "whiteboard_revisions_snapshot_r2_key_length_check" CHECK(length("snapshot_r2_key") <= 512),
	CONSTRAINT "whiteboard_revisions_snapshot_r2_key_check" CHECK(substr("snapshot_r2_key", 1, 12) = 'whiteboards/'
        AND substr("snapshot_r2_key", 13, length("whiteboard_id")) = "whiteboard_id"
        AND substr("snapshot_r2_key", 13 + length("whiteboard_id"), 11) = '/revisions/'),
	CONSTRAINT "whiteboard_revisions_document_clock_nonnegative_check" CHECK("document_clock" IS NULL OR "document_clock" >= 0),
	CONSTRAINT "whiteboard_revisions_snapshot_size_nonnegative_check" CHECK("snapshot_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE `whiteboards` (
	`id` text PRIMARY KEY NOT NULL,
	`sync_room_id` text NOT NULL UNIQUE,
	`space_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text,
	`archived_at` integer,
	`current_snapshot_r2_key` text,
	`current_snapshot_hash` text,
	`current_document_clock` integer,
	`current_snapshot_size` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_whiteboards_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_whiteboards_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT "whiteboards_title_length_check" CHECK(length("title") <= 200 AND length(trim("title")) BETWEEN 1 AND 200),
	CONSTRAINT "whiteboards_sync_room_id_length_check" CHECK(length("sync_room_id") <= 64 AND length(trim("sync_room_id")) BETWEEN 1 AND 64),
	CONSTRAINT "whiteboards_status_check" CHECK("status" in ('active', 'archived')),
	CONSTRAINT "whiteboards_snapshot_hash_check" CHECK("current_snapshot_hash" IS NULL OR length("current_snapshot_hash") = 32),
	CONSTRAINT "whiteboards_snapshot_r2_key_check" CHECK("current_snapshot_r2_key" IS NULL
        OR "current_snapshot_r2_key" = 'internal/whiteboards/' || "id" || '/state/current.json'),
	CONSTRAINT "whiteboards_document_clock_nonnegative_check" CHECK("current_document_clock" IS NULL OR "current_document_clock" >= 0),
	CONSTRAINT "whiteboards_snapshot_size_nonnegative_check" CHECK("current_snapshot_size" IS NULL OR "current_snapshot_size" >= 0),
	CONSTRAINT "whiteboards_status_shape_check" CHECK((
        ("status" = 'active' AND "archived_at" IS NULL)
        OR ("status" = 'archived' AND "archived_at" IS NOT NULL)
      )),
	CONSTRAINT "whiteboards_archived_after_created_check" CHECK("archived_at" IS NULL OR "archived_at" >= "created_at"),
	CONSTRAINT "whiteboards_updated_after_created_check" CHECK("updated_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE `meeting_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`space_id` text NOT NULL,
	`revision_id` text,
	`type` text NOT NULL,
	`r2_key` text NOT NULL UNIQUE,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_by_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_artifacts_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_artifacts_space_id_spaces_id_fk` FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_meeting_artifacts_revision_id_whiteboard_revisions_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `whiteboard_revisions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_meeting_artifacts_uploaded_by_id_users_id_fk` FOREIGN KEY (`uploaded_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT `meeting_artifacts_meeting_space_fk` FOREIGN KEY (`meeting_id`,`space_id`) REFERENCES `meetings`(`id`,`space_id`),
	CONSTRAINT "meeting_artifacts_type_check" CHECK("type" in ('recording', 'whiteboard_snapshot', 'whiteboard_state', 'whiteboard_pdf')),
	CONSTRAINT "meeting_artifacts_size_nonnegative_check" CHECK("size" >= 0),
	CONSTRAINT "meeting_artifacts_filename_length_check" CHECK(length("filename") <= 255 AND length(trim("filename")) BETWEEN 1 AND 255),
	CONSTRAINT "meeting_artifacts_mime_type_length_check" CHECK(length("mime_type") <= 100 AND length(trim("mime_type")) BETWEEN 1 AND 100),
	CONSTRAINT "meeting_artifacts_r2_key_length_check" CHECK(length("r2_key") <= 512),
	CONSTRAINT "meeting_artifacts_r2_key_check" CHECK((
        ("type" = 'recording'
          AND substr("r2_key", 1, 9) = 'meetings/'
          AND substr("r2_key", 10, length("meeting_id")) = "meeting_id"
          AND substr("r2_key", 10 + length("meeting_id"), 12) = '/recordings/')
        OR ("type" = 'whiteboard_snapshot'
          AND substr("r2_key", 1, 18) = 'internal/meetings/'
          AND substr("r2_key", 19, length("meeting_id")) = "meeting_id"
          AND substr("r2_key", 19 + length("meeting_id"), 10) = '/recorder/')
        OR ("type" = 'whiteboard_state'
          AND substr("r2_key", 1, 21) = 'internal/whiteboards/')
        OR ("type" = 'whiteboard_pdf'
          AND (
            "r2_key" = 'meetings/' || "meeting_id" || '/exports/whiteboard.pdf'
            OR (
              substr("r2_key", 1, 9 + length("meeting_id") + 20)
                = 'meetings/' || "meeting_id" || '/exports/whiteboard/'
              AND length("r2_key") > 9 + length("meeting_id") + 24
              AND substr("r2_key", -4) = '.pdf'
            )
          ))
      ))
);
--> statement-breakpoint
CREATE TABLE `maintenance_cursors` (
	`job` text PRIMARY KEY NOT NULL,
	`cursor_at` integer,
	`cursor_id` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "maintenance_cursors_job_length_check" CHECK(length("job") <= 100 AND length(trim("job")) BETWEEN 1 AND 100),
	CONSTRAINT "maintenance_cursors_shape_check" CHECK(("cursor_at" IS NULL AND "cursor_id" IS NULL) OR ("cursor_at" IS NOT NULL AND "cursor_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `r2_object_cleanup_tasks` (
	`r2_key` text PRIMARY KEY NOT NULL,
	`not_before` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "r2_object_cleanup_tasks_key_check" CHECK(length("r2_key") between 1 and 1000),
	CONSTRAINT "r2_object_cleanup_tasks_attempts_check" CHECK("attempts" >= 0),
	CONSTRAINT "r2_object_cleanup_tasks_error_check" CHECK("last_error" IS NULL OR length("last_error") <= 1000)
);
--> statement-breakpoint
CREATE TABLE `webhook_event_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`event_created_at` integer,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	`processing_started_at` integer,
	`processing_lease_expires_at` integer,
	`processing_owner_token` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "webhook_event_receipts_provider_length_check" CHECK(length("provider") <= 64 AND length(trim("provider")) BETWEEN 1 AND 64),
	CONSTRAINT "webhook_event_receipts_event_id_length_check" CHECK(length("event_id") <= 255 AND length(trim("event_id")) BETWEEN 1 AND 255),
	CONSTRAINT "webhook_event_receipts_event_type_length_check" CHECK(length("event_type") <= 100 AND length(trim("event_type")) BETWEEN 1 AND 100),
	CONSTRAINT "webhook_event_receipts_owner_token_length_check" CHECK("processing_owner_token" IS NULL OR length("processing_owner_token") <= 64),
	CONSTRAINT "webhook_event_receipts_processed_after_received_check" CHECK("processed_at" IS NULL OR "processed_at" >= "received_at"),
	CONSTRAINT "webhook_event_receipts_lease_after_started_check" CHECK("processing_lease_expires_at" IS NULL OR "processing_started_at" IS NOT NULL),
	CONSTRAINT "webhook_event_receipts_attempt_count_check" CHECK("attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `accounts_user_id_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_account_idx` ON `accounts` (`provider_id`,`provider_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_user_provider_idx` ON `accounts` (`user_id`,`provider_id`);--> statement-breakpoint
CREATE INDEX `passkeys_user_id_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE INDEX `personal_access_tokens_user_id_idx` ON `personal_access_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `personal_access_tokens_expires_at_idx` ON `personal_access_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_absolute_expires_at_idx` ON `sessions` (`absolute_expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_previous_token_hash_idx` ON `sessions` (`previous_token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_previous_token_expires_at_idx` ON `sessions` (`previous_token_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_paddle_customer_id_idx` ON `users` (`paddle_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_paddle_subscription_id_idx` ON `users` (`paddle_subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `verifications_type_identifier_unique` ON `verifications` (`type`,`identifier`);--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);--> statement-breakpoint
CREATE INDEX `verifications_expires_at_idx` ON `verifications` (`expires_at`);--> statement-breakpoint
CREATE INDEX `devices_user_id_idx` ON `devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `devices_session_id_idx` ON `devices` (`session_id`);--> statement-breakpoint
CREATE INDEX `devices_expires_at_idx` ON `devices` (`expires_at`);--> statement-breakpoint
CREATE INDEX `organization_members_user_id_idx` ON `organization_members` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_members_unique_idx` ON `organization_members` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `organization_ownership_transfers_requested_by_idx` ON `organization_ownership_transfers` (`requested_by_user_id`);--> statement-breakpoint
CREATE INDEX `organization_ownership_transfers_proposed_owner_idx` ON `organization_ownership_transfers` (`proposed_owner_user_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `organization_ownership_transfers_expires_at_idx` ON `organization_ownership_transfers` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_owner_id_idx` ON `organizations` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_paddle_customer_id_idx` ON `organizations` (`paddle_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_paddle_subscription_id_idx` ON `organizations` (`paddle_subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_id_space_unique_idx` ON `files` (`id`,`space_id`);--> statement-breakpoint
CREATE INDEX `files_space_status_created_idx` ON `files` (`space_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `files_uploader_status_size_idx` ON `files` (`uploaded_by_id`,`status`,`size`);--> statement-breakpoint
CREATE INDEX `files_pending_expiry_idx` ON `files` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `files_content_hash_idx` ON `files` (`content_hash`);--> statement-breakpoint
CREATE INDEX `space_audit_events_space_created_id_idx` ON `space_audit_events` (`space_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `space_audit_events_space_action_idx` ON `space_audit_events` (`space_id`,`action`);--> statement-breakpoint
CREATE INDEX `space_audit_events_actor_id_idx` ON `space_audit_events` (`actor_id`);--> statement-breakpoint
CREATE INDEX `space_audit_events_target_id_idx` ON `space_audit_events` (`target_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `space_invites_space_id_unique_idx` ON `space_invites` (`space_id`);--> statement-breakpoint
CREATE INDEX `space_invites_created_by_id_idx` ON `space_invites` (`created_by_id`);--> statement-breakpoint
CREATE INDEX `space_members_user_id_idx` ON `space_members` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `space_members_unique_idx` ON `space_members` (`space_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `space_members_single_owner_idx` ON `space_members` (`space_id`) WHERE "space_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX `spaces_organization_id_idx` ON `spaces` (`organization_id`);--> statement-breakpoint
CREATE INDEX `spaces_owner_archived_idx` ON `spaces` (`owner_user_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `spaces_archived_at_id_idx` ON `spaces` (`archived_at`,`id`) WHERE "spaces"."archived_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_personal_owner_unique_idx` ON `spaces` (`owner_user_id`) WHERE "spaces"."kind" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_slug_unique_idx` ON `spaces` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_id_kind_unique_idx` ON `spaces` (`id`,`kind`);--> statement-breakpoint
CREATE INDEX `meeting_links_space_reuse_archived_last_used_idx` ON `meeting_links` (`space_id`,`reuse_policy`,`archived_at`,`last_used_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_links_shared_space_unique_idx` ON `meeting_links` (`space_id`) WHERE "meeting_links"."space_kind" = 'shared'
        AND "meeting_links"."reuse_policy" = 'reusable'
        AND "meeting_links"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_links_personal_room_unique_idx` ON `meeting_links` (`space_id`) WHERE "meeting_links"."space_kind" = 'personal'
        AND "meeting_links"."reuse_policy" = 'reusable'
        AND "meeting_links"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_links_id_space_unique_idx` ON `meeting_links` (`id`,`space_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_links_id_reuse_policy_unique_idx` ON `meeting_links` (`id`,`reuse_policy`);--> statement-breakpoint
CREATE INDEX `meeting_links_expires_at_idx` ON `meeting_links` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `space_default_meeting_links_link_unique_idx` ON `space_default_meeting_links` (`meeting_link_id`);--> statement-breakpoint
CREATE INDEX `email_suppressions_created_idx` ON `email_suppressions` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_admissions_id_meeting_id_unique_idx` ON `meeting_admissions` (`id`,`meeting_id`);--> statement-breakpoint
CREATE INDEX `meeting_admissions_meeting_status_created_idx` ON `meeting_admissions` (`meeting_id`,`admission_status`,`created_at`);--> statement-breakpoint
CREATE INDEX `meeting_admissions_meeting_user_idx` ON `meeting_admissions` (`meeting_id`,`subject_user_id`);--> statement-breakpoint
CREATE INDEX `meeting_admissions_meeting_created_idx` ON `meeting_admissions` (`meeting_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `meeting_admissions_subject_user_id_idx` ON `meeting_admissions` (`subject_user_id`);--> statement-breakpoint
CREATE INDEX `meeting_admissions_decided_by_user_id_idx` ON `meeting_admissions` (`decided_by_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_connections_id_meeting_id_unique_idx` ON `meeting_connections` (`id`,`meeting_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_connections_meeting_identity_unique_idx` ON `meeting_connections` (`meeting_id`,`livekit_identity`);--> statement-breakpoint
CREATE INDEX `meeting_connections_admission_id_idx` ON `meeting_connections` (`admission_id`);--> statement-breakpoint
CREATE INDEX `meeting_connections_meeting_admission_status_updated_idx` ON `meeting_connections` (`meeting_id`,`admission_id`,`connection_status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `meeting_connections_meeting_status_connected_idx` ON `meeting_connections` (`meeting_id`,`connection_status`,`connected_at`,`token_issued_at`,`id`);--> statement-breakpoint
CREATE INDEX `meeting_connections_meeting_user_idx` ON `meeting_connections` (`meeting_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `meeting_connections_user_status_meeting_idx` ON `meeting_connections` (`user_id`,`connection_status`,`meeting_id`);--> statement-breakpoint
CREATE INDEX `meeting_connections_user_meeting_idx` ON `meeting_connections` (`user_id`,`meeting_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_schedule_attendees_schedule_email_unique_idx` ON `meeting_schedule_attendees` (`schedule_id`,`normalized_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_schedule_attendees_id_schedule_unique_idx` ON `meeting_schedule_attendees` (`id`,`schedule_id`);--> statement-breakpoint
CREATE INDEX `meeting_schedule_attendees_user_starts_idx` ON `meeting_schedule_attendees` (`user_id`,`schedule_id`);--> statement-breakpoint
CREATE INDEX `meeting_schedule_attendees_normalized_email_idx` ON `meeting_schedule_attendees` (`normalized_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_schedule_notifications_delivery_unique_idx` ON `meeting_schedule_notifications` (`schedule_id`,`attendee_id`,`revision`,`kind`);--> statement-breakpoint
CREATE INDEX `meeting_schedule_notifications_due_idx` ON `meeting_schedule_notifications` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `meeting_schedule_notifications_schedule_idx` ON `meeting_schedule_notifications` (`schedule_id`);--> statement-breakpoint
CREATE INDEX `meeting_schedule_notifications_attendee_idx` ON `meeting_schedule_notifications` (`attendee_id`);--> statement-breakpoint
CREATE INDEX `meeting_schedules_organizer_starts_idx` ON `meeting_schedules` (`organizer_user_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `meeting_schedules_starts_canceled_idx` ON `meeting_schedules` (`starts_at`,`canceled_at`);--> statement-breakpoint
CREATE INDEX `meeting_schedules_space_starts_idx` ON `meeting_schedules` (`space_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `meeting_schedules_link_starts_idx` ON `meeting_schedules` (`meeting_link_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `meeting_schedules_canceled_by_user_id_idx` ON `meeting_schedules` (`canceled_by_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_schedules_organizer_idempotency_unique_idx` ON `meeting_schedules` (`organizer_user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `meetings_link_status_idx` ON `meetings` (`meeting_link_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_id_space_id_unique_idx` ON `meetings` (`id`,`space_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_open_link_unique_idx` ON `meetings` (`meeting_link_id`) WHERE "meetings"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_open_space_unique_idx` ON `meetings` (`space_id`) WHERE "meetings"."status" = 'open' AND "meetings"."space_kind" = 'shared';--> statement-breakpoint
CREATE INDEX `meetings_space_id_status_idx` ON `meetings` (`space_id`,`status`);--> statement-breakpoint
CREATE INDEX `meetings_started_by_user_id_status_idx` ON `meetings` (`started_by_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `meetings_billing_principal_status_idx` ON `meetings` (`billing_principal_type`,`billing_principal_id`,`status`);--> statement-breakpoint
CREATE INDEX `meetings_status_started_at_idx` ON `meetings` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `meetings_retain_until_idx` ON `meetings` (`retain_until`);--> statement-breakpoint
CREATE INDEX `meetings_active_stream_egress_idx` ON `meetings` (`active_stream_egress_id`) WHERE "meetings"."active_stream_egress_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `user_contacts_owner_email_unique_idx` ON `user_contacts` (`owner_user_id`,`normalized_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_contacts_owner_user_unique_idx` ON `user_contacts` (`owner_user_id`,`contact_user_id`);--> statement-breakpoint
CREATE INDEX `user_contacts_owner_name_idx` ON `user_contacts` (`owner_user_id`,`display_name`);--> statement-breakpoint
CREATE INDEX `user_contacts_contact_user_id_idx` ON `user_contacts` (`contact_user_id`);--> statement-breakpoint
CREATE INDEX `user_contacts_last_meeting_id_idx` ON `user_contacts` (`last_meeting_id`);--> statement-breakpoint
CREATE INDEX `transcripts_meeting_id_started_at_id_idx` ON `transcripts` (`meeting_id`,`started_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transcripts_segment_id_unique` ON `transcripts` (`meeting_id`,`segment_id`);--> statement-breakpoint
CREATE INDEX `transcripts_admission_id_idx` ON `transcripts` (`admission_id`);--> statement-breakpoint
CREATE INDEX `transcripts_connection_id_idx` ON `transcripts` (`connection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_summaries_meeting_id_unique` ON `meeting_summaries` (`meeting_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_whiteboard_pages_usage_page_unique_idx` ON `meeting_whiteboard_pages` (`meeting_whiteboard_id`,`page_id`);--> statement-breakpoint
CREATE INDEX `meeting_whiteboard_pages_handout_idx` ON `meeting_whiteboard_pages` (`meeting_whiteboard_id`,`handout_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_whiteboards_meeting_board_unique_idx` ON `meeting_whiteboards` (`meeting_id`,`whiteboard_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_whiteboards_focused_meeting_unique_idx` ON `meeting_whiteboards` (`meeting_id`) WHERE "meeting_whiteboards"."focused_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_whiteboards_id_meeting_unique_idx` ON `meeting_whiteboards` (`id`,`meeting_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_whiteboards_id_meeting_board_unique_idx` ON `meeting_whiteboards` (`id`,`meeting_id`,`whiteboard_id`);--> statement-breakpoint
CREATE INDEX `meeting_whiteboards_meeting_attached_idx` ON `meeting_whiteboards` (`meeting_id`,`attached_at`);--> statement-breakpoint
CREATE INDEX `meeting_whiteboards_space_idx` ON `meeting_whiteboards` (`space_id`);--> statement-breakpoint
CREATE INDEX `meeting_whiteboards_board_attached_idx` ON `meeting_whiteboards` (`whiteboard_id`,`attached_at`);--> statement-breakpoint
CREATE INDEX `meeting_whiteboards_start_revision_idx` ON `meeting_whiteboards` (`start_revision_id`);--> statement-breakpoint
CREATE INDEX `meeting_whiteboards_captured_revision_idx` ON `meeting_whiteboards` (`captured_revision_id`);--> statement-breakpoint
CREATE INDEX `operation_leases_expires_idx` ON `operation_leases` (`expires_at`);--> statement-breakpoint
CREATE INDEX `upload_reservations_principal_expires_idx` ON `upload_reservations` (`principal`,`expires_at`);--> statement-breakpoint
CREATE INDEX `upload_reservations_expires_idx` ON `upload_reservations` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `whiteboard_ai_usage_principal_day_unique` ON `whiteboard_ai_usage` (`principal`,`usage_day`);--> statement-breakpoint
CREATE INDEX `whiteboard_ai_usage_day_idx` ON `whiteboard_ai_usage` (`usage_day`);--> statement-breakpoint
CREATE UNIQUE INDEX `whiteboard_asset_references_board_key_unique_idx` ON `whiteboard_asset_references` (`whiteboard_id`,`r2_key`);--> statement-breakpoint
CREATE INDEX `whiteboard_asset_references_source_idx` ON `whiteboard_asset_references` (`source_whiteboard_id`,`r2_key`);--> statement-breakpoint
CREATE INDEX `whiteboard_assets_board_status_idx` ON `whiteboard_assets` (`whiteboard_id`,`status`);--> statement-breakpoint
CREATE INDEX `whiteboard_assets_space_created_idx` ON `whiteboard_assets` (`space_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `whiteboard_assets_uploader_status_size_idx` ON `whiteboard_assets` (`uploaded_by_user_id`,`status`,`size`);--> statement-breakpoint
CREATE INDEX `whiteboard_assets_guest_admission_idx` ON `whiteboard_assets` (`guest_admission_id`);--> statement-breakpoint
CREATE INDEX `whiteboard_assets_pending_expiry_idx` ON `whiteboard_assets` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `whiteboard_edit_grants_meeting_board_idx` ON `whiteboard_edit_grants` (`meeting_id`,`whiteboard_id`);--> statement-breakpoint
CREATE INDEX `whiteboard_edit_grants_whiteboard_idx` ON `whiteboard_edit_grants` (`whiteboard_id`);--> statement-breakpoint
CREATE INDEX `whiteboard_edit_grants_usage_idx` ON `whiteboard_edit_grants` (`meeting_whiteboard_id`);--> statement-breakpoint
CREATE INDEX `whiteboard_edit_grants_user_idx` ON `whiteboard_edit_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `whiteboard_edit_grants_admission_idx` ON `whiteboard_edit_grants` (`admission_id`);--> statement-breakpoint
CREATE INDEX `whiteboard_edit_grants_granted_by_idx` ON `whiteboard_edit_grants` (`granted_by_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `whiteboard_edit_grants_active_user_unique_idx` ON `whiteboard_edit_grants` (`meeting_whiteboard_id`,`user_id`) WHERE "whiteboard_edit_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `whiteboard_edit_grants_active_admission_unique_idx` ON `whiteboard_edit_grants` (`meeting_whiteboard_id`,`admission_id`) WHERE "whiteboard_edit_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `whiteboard_file_references_file_idx` ON `whiteboard_file_references` (`file_id`);--> statement-breakpoint
CREATE INDEX `whiteboard_file_references_space_idx` ON `whiteboard_file_references` (`space_id`);--> statement-breakpoint
CREATE INDEX `whiteboard_revision_asset_references_key_idx` ON `whiteboard_revision_asset_references` (`r2_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `whiteboard_revisions_board_number_unique_idx` ON `whiteboard_revisions` (`whiteboard_id`,`revision_number`);--> statement-breakpoint
CREATE INDEX `whiteboard_revisions_space_created_idx` ON `whiteboard_revisions` (`space_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `whiteboard_revisions_meeting_idx` ON `whiteboard_revisions` (`source_meeting_id`);--> statement-breakpoint
CREATE INDEX `whiteboard_revisions_created_by_idx` ON `whiteboard_revisions` (`created_by_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `whiteboards_id_space_unique_idx` ON `whiteboards` (`id`,`space_id`);--> statement-breakpoint
CREATE INDEX `whiteboards_space_status_updated_idx` ON `whiteboards` (`space_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `whiteboards_created_by_user_idx` ON `whiteboards` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `meeting_artifacts_meeting_id_created_at_idx` ON `meeting_artifacts` (`meeting_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `meeting_artifacts_space_created_id_idx` ON `meeting_artifacts` (`space_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `meeting_artifacts_meeting_type_idx` ON `meeting_artifacts` (`meeting_id`,`type`);--> statement-breakpoint
CREATE INDEX `meeting_artifacts_revision_idx` ON `meeting_artifacts` (`revision_id`);--> statement-breakpoint
CREATE INDEX `meeting_artifacts_uploader_meeting_size_idx` ON `meeting_artifacts` (`uploaded_by_id`,`meeting_id`,`size`);--> statement-breakpoint
CREATE INDEX `r2_object_cleanup_tasks_due_idx` ON `r2_object_cleanup_tasks` (`not_before`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_event_receipts_provider_event_unique_idx` ON `webhook_event_receipts` (`provider`,`event_id`);--> statement-breakpoint
CREATE INDEX `webhook_event_receipts_provider_received_idx` ON `webhook_event_receipts` (`provider`,`received_at`);--> statement-breakpoint
CREATE INDEX `webhook_event_receipts_provider_lease_idx` ON `webhook_event_receipts` (`provider`,`processed_at`,`processing_lease_expires_at`);--> statement-breakpoint
CREATE INDEX `webhook_event_receipts_processed_idx` ON `webhook_event_receipts` (`processed_at`,`id`);
--> statement-breakpoint
-- Cross-table invariants that a CHECK cannot express.
CREATE TRIGGER `meeting_links_one_time_occurrence_count_update`
BEFORE UPDATE OF `reuse_policy` ON `meeting_links`
WHEN NEW.`reuse_policy` = 'one_time'
  AND (
    SELECT count(*) FROM `meetings` AS occurrence
    WHERE occurrence.`meeting_link_id` = NEW.`id`
  ) > 1
BEGIN
  SELECT RAISE(ABORT, 'one-time meeting link has multiple occurrences');
END;
--> statement-breakpoint
CREATE TRIGGER `meeting_links_space_default_update_check`
BEFORE UPDATE OF `expires_at`, `archived_at` ON `meeting_links`
WHEN EXISTS (
  SELECT 1 FROM `space_default_meeting_links`
  WHERE `space_default_meeting_links`.`meeting_link_id` = OLD.`id`
)
  AND (NEW.`expires_at` IS NOT NULL OR NEW.`archived_at` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a Space default must remain active and permanent');
END;
--> statement-breakpoint
CREATE TRIGGER `meeting_whiteboards_captured_revision_insert_check`
BEFORE INSERT ON `meeting_whiteboards`
WHEN NEW.`captured_revision_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `whiteboard_revisions`
  WHERE `whiteboard_revisions`.`id` = NEW.`captured_revision_id`
    AND `whiteboard_revisions`.`whiteboard_id` = NEW.`whiteboard_id`
)
BEGIN
  SELECT RAISE(ABORT, 'a captured revision must belong to the attached Whiteboard');
END;
--> statement-breakpoint
CREATE TRIGGER `meeting_whiteboards_captured_revision_update_check`
BEFORE UPDATE OF `whiteboard_id`, `captured_revision_id` ON `meeting_whiteboards`
WHEN NEW.`captured_revision_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `whiteboard_revisions`
  WHERE `whiteboard_revisions`.`id` = NEW.`captured_revision_id`
    AND `whiteboard_revisions`.`whiteboard_id` = NEW.`whiteboard_id`
)
BEGIN
  SELECT RAISE(ABORT, 'a captured revision must belong to the attached Whiteboard');
END;
--> statement-breakpoint
CREATE TRIGGER `meeting_whiteboards_start_revision_insert_check`
BEFORE INSERT ON `meeting_whiteboards`
WHEN NEW.`start_revision_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `whiteboard_revisions`
  WHERE `whiteboard_revisions`.`id` = NEW.`start_revision_id`
    AND `whiteboard_revisions`.`whiteboard_id` = NEW.`whiteboard_id`
)
BEGIN
  SELECT RAISE(ABORT, 'a start revision must belong to the attached Whiteboard');
END;
--> statement-breakpoint
CREATE TRIGGER `meeting_whiteboards_start_revision_update_check`
BEFORE UPDATE OF `whiteboard_id`, `start_revision_id` ON `meeting_whiteboards`
WHEN NEW.`start_revision_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `whiteboard_revisions`
  WHERE `whiteboard_revisions`.`id` = NEW.`start_revision_id`
    AND `whiteboard_revisions`.`whiteboard_id` = NEW.`whiteboard_id`
)
BEGIN
  SELECT RAISE(ABORT, 'a start revision must belong to the attached Whiteboard');
END;
--> statement-breakpoint
CREATE TRIGGER `meetings_one_time_link_single_occurrence_insert`
BEFORE INSERT ON `meetings`
WHEN EXISTS (
  SELECT 1
  FROM `meeting_links` AS one_time_link
  WHERE one_time_link.`id` = NEW.`meeting_link_id`
    AND one_time_link.`reuse_policy` = 'one_time'
    AND (
      one_time_link.`spent_at` IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM `meetings` AS prior_occurrence
        WHERE prior_occurrence.`meeting_link_id` = NEW.`meeting_link_id`
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'one-time meeting link already spent');
END;
--> statement-breakpoint
CREATE TRIGGER `meetings_one_time_link_single_occurrence_update`
BEFORE UPDATE OF `meeting_link_id` ON `meetings`
WHEN NEW.`meeting_link_id` <> OLD.`meeting_link_id`
  AND EXISTS (
    SELECT 1
    FROM `meeting_links` AS one_time_link
    WHERE one_time_link.`id` = NEW.`meeting_link_id`
      AND one_time_link.`reuse_policy` = 'one_time'
      AND (
        one_time_link.`spent_at` IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM `meetings` AS prior_occurrence
          WHERE prior_occurrence.`meeting_link_id` = NEW.`meeting_link_id`
            AND prior_occurrence.`id` <> OLD.`id`
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'one-time meeting link already spent');
END;
--> statement-breakpoint
CREATE TRIGGER `space_default_meeting_links_insert_check`
BEFORE INSERT ON `space_default_meeting_links`
WHEN NOT EXISTS (
  SELECT 1 FROM `meeting_links`
  WHERE `meeting_links`.`id` = NEW.`meeting_link_id`
    AND `meeting_links`.`expires_at` IS NULL
    AND `meeting_links`.`archived_at` IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'a Space default must be an active permanent link');
END;
--> statement-breakpoint
CREATE TRIGGER `space_default_meeting_links_update_check`
BEFORE UPDATE ON `space_default_meeting_links`
WHEN NOT EXISTS (
  SELECT 1 FROM `meeting_links`
  WHERE `meeting_links`.`id` = NEW.`meeting_link_id`
    AND `meeting_links`.`expires_at` IS NULL
    AND `meeting_links`.`archived_at` IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'a Space default must be an active permanent link');
END;
--> statement-breakpoint
CREATE TRIGGER `spaces_kind_immutable_check`
BEFORE UPDATE OF `kind` ON `spaces`
WHEN NEW.`kind` <> OLD.`kind`
BEGIN
  SELECT RAISE(ABORT, 'a Space kind is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `transcripts_meeting_projection_insert`
AFTER INSERT ON `transcripts`
BEGIN
  UPDATE `meetings`
  SET
    `transcript_segment_count` = `transcript_segment_count` + 1,
    `transcript_last_ingested_at` = CASE
      WHEN `transcript_last_ingested_at` IS NULL
        OR NEW.`updated_at` > `transcript_last_ingested_at`
      THEN NEW.`updated_at`
      ELSE `transcript_last_ingested_at`
    END,
    `updated_at` = max(`updated_at`, NEW.`updated_at`)
  WHERE `id` = NEW.`meeting_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `whiteboard_asset_references_authorized_source_insert_check`
BEFORE INSERT ON `whiteboard_asset_references`
WHEN NOT EXISTS (
  SELECT 1 FROM `whiteboard_assets`
  WHERE `whiteboard_assets`.`r2_key` = NEW.`r2_key`
    AND `whiteboard_assets`.`whiteboard_id` = NEW.`source_whiteboard_id`
    AND `whiteboard_assets`.`status` = 'committed'
)
AND NOT EXISTS (
  SELECT 1 FROM `whiteboard_asset_references`
  WHERE `whiteboard_asset_references`.`whiteboard_id` = NEW.`source_whiteboard_id`
    AND `whiteboard_asset_references`.`r2_key` = NEW.`r2_key`
)
BEGIN
  SELECT RAISE(ABORT, 'a Whiteboard copy can only retain an authorized source asset');
END;
--> statement-breakpoint
CREATE TRIGGER `whiteboard_asset_references_authorized_source_update_check`
BEFORE UPDATE OF `source_whiteboard_id`, `r2_key` ON `whiteboard_asset_references`
WHEN NOT EXISTS (
  SELECT 1 FROM `whiteboard_assets`
  WHERE `whiteboard_assets`.`r2_key` = NEW.`r2_key`
    AND `whiteboard_assets`.`whiteboard_id` = NEW.`source_whiteboard_id`
    AND `whiteboard_assets`.`status` = 'committed'
)
AND NOT EXISTS (
  SELECT 1 FROM `whiteboard_asset_references`
  WHERE `whiteboard_asset_references`.`whiteboard_id` = NEW.`source_whiteboard_id`
    AND `whiteboard_asset_references`.`r2_key` = NEW.`r2_key`
)
BEGIN
  SELECT RAISE(ABORT, 'a Whiteboard copy can only retain an authorized source asset');
END;
--> statement-breakpoint
CREATE TRIGGER `whiteboard_revision_asset_references_authorized_asset_insert_check`
BEFORE INSERT ON `whiteboard_revision_asset_references`
WHEN NOT EXISTS (
  SELECT 1 FROM `whiteboard_assets`
  WHERE `whiteboard_assets`.`r2_key` = NEW.`r2_key`
    AND `whiteboard_assets`.`status` = 'committed'
)
AND NOT EXISTS (
  SELECT 1
  FROM `whiteboard_revisions`
  INNER JOIN `whiteboard_asset_references`
    ON `whiteboard_asset_references`.`whiteboard_id` = `whiteboard_revisions`.`whiteboard_id`
   AND `whiteboard_asset_references`.`r2_key` = NEW.`r2_key`
  WHERE `whiteboard_revisions`.`id` = NEW.`revision_id`
)
BEGIN
  SELECT RAISE(ABORT, 'a revision can only retain an authorized committed Whiteboard asset');
END;
--> statement-breakpoint
CREATE TRIGGER `whiteboard_revision_asset_references_authorized_asset_update_check`
BEFORE UPDATE OF `revision_id`, `r2_key` ON `whiteboard_revision_asset_references`
WHEN NOT EXISTS (
  SELECT 1 FROM `whiteboard_assets`
  WHERE `whiteboard_assets`.`r2_key` = NEW.`r2_key`
    AND `whiteboard_assets`.`status` = 'committed'
)
AND NOT EXISTS (
  SELECT 1
  FROM `whiteboard_revisions`
  INNER JOIN `whiteboard_asset_references`
    ON `whiteboard_asset_references`.`whiteboard_id` = `whiteboard_revisions`.`whiteboard_id`
   AND `whiteboard_asset_references`.`r2_key` = NEW.`r2_key`
  WHERE `whiteboard_revisions`.`id` = NEW.`revision_id`
)
BEGIN
  SELECT RAISE(ABORT, 'a revision can only retain an authorized committed Whiteboard asset');
END;
--> statement-breakpoint
PRAGMA optimize;
