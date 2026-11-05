/** Shared public catalog filter; implementation is runtime-neutral JavaScript. */
export function catalogMatches(row: { archived?: boolean | null; title?: string | null }, options?: { archive?: "exclude" | "include" | "only"; title?: string }): boolean;
