/** Types for `build-security-txt.mjs`, imported by the tests. */
export const SECURITY_TXT_FILE: string;
export const SECURITY_TXT_URL: string;
export const EXPIRES_AFTER_DAYS: number;

/**
 * The file for a build made at `builtAt` whose contact link is `contact`,
 * the build's (`CONTACT_MAILTO`) unless given; `null` for a build with no
 * contact address, which has no file (issue #369).
 */
export function securityTxt(builtAt: Date | undefined, contact: string): string;
export function securityTxt(builtAt?: Date, contact?: string | null): string | null;
