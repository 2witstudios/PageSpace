import * as jose from 'jose';
import { type ServiceScope, type ServiceTokenClaims } from './services/service-auth';
interface UserPayload extends jose.JWTPayload {
    userId: string;
    tokenVersion: number;
    role: 'user' | 'admin';
}
export declare function decodeToken(token: string): Promise<UserPayload | null>;
export declare function generateAccessToken(userId: string, tokenVersion: number, role: 'user' | 'admin'): Promise<string>;
export declare function generateRefreshToken(userId: string, tokenVersion: number, role: 'user' | 'admin'): Promise<string>;
export declare function isAdmin(userPayload: UserPayload): boolean;
export declare function requireAdminPayload(userPayload: UserPayload | null): void;
export declare function createServiceToken(service: string, permissions?: string[], options?: {
    tenantId?: string;
    userId?: string;
    driveIds?: string[];
    expirationTime?: string;
}): Promise<string>;
export declare function verifyServiceToken(token: string): Promise<ServiceTokenClaims | null>;
export type { ServiceScope, ServiceTokenClaims };
//# sourceMappingURL=auth-utils.d.ts.map