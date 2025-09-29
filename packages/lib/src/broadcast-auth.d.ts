/**
 * Generates an HMAC signature for broadcast request authentication
 * @param requestBody - The JSON request body as a string
 * @param timestamp - Unix timestamp in seconds (defaults to current time)
 * @returns Object with timestamp and signature for header construction
 */
export declare function generateBroadcastSignature(requestBody: string, timestamp?: number): {
    timestamp: number;
    signature: string;
};
/**
 * Formats the signature for the X-Broadcast-Signature header
 * @param timestamp - Unix timestamp in seconds
 * @param signature - HMAC signature hex string
 * @returns Formatted header value: "t=timestamp,v1=signature"
 */
export declare function formatSignatureHeader(timestamp: number, signature: string): string;
/**
 * Verifies the HMAC signature from a broadcast request
 * @param signatureHeader - Value from X-Broadcast-Signature header
 * @param requestBody - Raw request body as string
 * @returns true if signature is valid and not expired, false otherwise
 */
export declare function verifyBroadcastSignature(signatureHeader: string, requestBody: string): boolean;
/**
 * Creates a signed request header for broadcast requests
 * @param requestBody - JSON request body as string
 * @returns Object with headers to include in fetch request
 */
export declare function createSignedBroadcastHeaders(requestBody: string): Record<string, string>;
//# sourceMappingURL=broadcast-auth.d.ts.map