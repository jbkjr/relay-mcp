/**
 * Whether `child` is `parent` or lies inside it, by path alone: no filesystem call, so links are not
 * followed (unlike `inside()` in core/config.ts). Every path the confinement code compares is
 * resolved first (seatbelt.ts `canonical`), so lexical containment is what it means.
 */
export const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
