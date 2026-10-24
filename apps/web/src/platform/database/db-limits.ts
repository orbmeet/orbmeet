import { truncateCodeUnits } from "@orbmeet/primitives";

export const D1_MAX_BOUND_PARAMETERS = 100;

/** `user_contacts_display_name_length_check`. */
export const CONTACT_DISPLAY_NAME_MAX_LENGTH = 100;

/**
 * Clamp text to a column's trimmed-length CHECK without cutting a surrogate
 * pair in half.
 *
 * The contact index falls back to the raw email address when nothing better is
 * known, and a valid address can be longer than the column allows — which
 * failed the whole contact batch on a constraint rather than storing a
 * slightly shortened label.
 */
export function clampToColumnLength(value: string, maxLength: number): string {
  return truncateCodeUnits(value.trim(), maxLength).trim();
}
