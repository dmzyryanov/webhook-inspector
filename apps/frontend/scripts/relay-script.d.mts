/** Types for `relay-script.mjs`, imported by the tests. */
export const RELAY_SCRIPT_NAME: string;
export const OLD_RELAY_SCRIPT_NAME: string;
export const RELAY_SCRIPT_FILE: string;
export const RELAY_SCRIPT_API: string;
export const RELAY_SECTION_HEADING: string;

export function sha256Hex(bytes: Uint8Array | string): string;
export function relaySection(description: string): string | undefined;
export function documentedRelayHashes(description: string): string[];
