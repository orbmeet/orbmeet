import { Errors } from "@/lib/app-errors";

/** A Space row's canonical URL slug; every persisted Space has one. */
export function requireSpaceSlug(slug: string | null): string {
  if (!slug) {
    throw Errors.CONFIG_ERROR("Space is missing its canonical URL slug");
  }
  return slug;
}
