import { type JWTPayload } from 'jose';
export type ServiceScope = '*' | 'files:read' | 'files:write' | 'files:link' | 'files:delete' | 'files:optimize' | 'files:ingest' | 'files:write:any' | 'avatars:write' | 'avatars:write:any' | 'queue:read';
export interface ServiceTokenClaims extends JWTPayload {
    sub: string;
    service: string;
    resource?: string;
    driveId?: string;
    tenantId?: string;
    userId?: string;
    driveIds?: string[];
    scopes: ServiceScope[];
    tokenType: 'service';
    jti: string;
}
export interface ServiceTokenOptions {
    service: string;
    subject: string;
    resource?: string;
    driveId?: string;
    scopes: ServiceScope[];
    expiresIn?: string;
    additionalClaims?: Record<string, unknown>;
}
export declare function createServiceToken(options: ServiceTokenOptions): Promise<string>;
export declare function verifyServiceToken(token: string): Promise<ServiceTokenClaims>;
export declare function decodeServiceTokenHeader(token: string): import("jose").ProtectedHeaderParameters;
export declare function hasScope(claims: ServiceTokenClaims, scope: ServiceScope): boolean;
export declare function assertScope(claims: ServiceTokenClaims, scope: ServiceScope): void;
export interface ServiceAuthResult {
    claims: ServiceTokenClaims;
}
export declare function authenticateServiceToken(token: string): Promise<ServiceAuthResult>;
export declare function requireResource(claims: ServiceTokenClaims, resource: string | undefined, kind: 'page' | 'drive'): string;
//# sourceMappingURL=service-auth.d.ts.map