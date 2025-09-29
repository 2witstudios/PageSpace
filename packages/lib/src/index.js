"use strict";
// Server-side exports (includes Node.js modules)
// For client-safe exports, use '@pagespace/lib/client-safe'
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertServiceScope = exports.hasServiceScope = exports.hasScope = exports.decodeServiceTokenHeader = exports.authenticateServiceToken = exports.verifyServiceTokenV2 = exports.createServiceTokenV2 = exports.getUserAccessiblePagesInDrive = exports.getUserAccessiblePagesInDriveWithDetails = void 0;
// All exports including server-side modules
__exportStar(require("./page-content-parser"), exports);
__exportStar(require("./permissions-cached"), exports); // Server-only: cached permissions (preferred)
// Export specific functions from original permissions that aren't in cached version
var permissions_1 = require("./permissions");
Object.defineProperty(exports, "getUserAccessiblePagesInDriveWithDetails", { enumerable: true, get: function () { return permissions_1.getUserAccessiblePagesInDriveWithDetails; } });
Object.defineProperty(exports, "getUserAccessiblePagesInDrive", { enumerable: true, get: function () { return permissions_1.getUserAccessiblePagesInDrive; } });
__exportStar(require("./tree-utils"), exports);
__exportStar(require("./utils"), exports);
__exportStar(require("./enums"), exports);
__exportStar(require("./types"), exports);
__exportStar(require("./notifications"), exports);
__exportStar(require("./page-types.config"), exports);
__exportStar(require("./page-type-validators"), exports);
__exportStar(require("./sheet"), exports);
// Auth and security utilities (server-only)
__exportStar(require("./auth-utils"), exports);
var service_auth_1 = require("./services/service-auth");
Object.defineProperty(exports, "createServiceTokenV2", { enumerable: true, get: function () { return service_auth_1.createServiceToken; } });
Object.defineProperty(exports, "verifyServiceTokenV2", { enumerable: true, get: function () { return service_auth_1.verifyServiceToken; } });
Object.defineProperty(exports, "authenticateServiceToken", { enumerable: true, get: function () { return service_auth_1.authenticateServiceToken; } });
Object.defineProperty(exports, "decodeServiceTokenHeader", { enumerable: true, get: function () { return service_auth_1.decodeServiceTokenHeader; } });
Object.defineProperty(exports, "hasScope", { enumerable: true, get: function () { return service_auth_1.hasScope; } });
Object.defineProperty(exports, "hasServiceScope", { enumerable: true, get: function () { return service_auth_1.hasScope; } });
Object.defineProperty(exports, "assertServiceScope", { enumerable: true, get: function () { return service_auth_1.assertScope; } });
__exportStar(require("./csrf-utils"), exports);
__exportStar(require("./encryption-utils"), exports);
__exportStar(require("./rate-limit-utils"), exports);
// Logging utilities (server-only)
__exportStar(require("./logger"), exports);
__exportStar(require("./logger-config"), exports);
__exportStar(require("./logger-database"), exports);
// Monitoring and tracking utilities (server-only)
__exportStar(require("./ai-monitoring"), exports);
__exportStar(require("./activity-tracker"), exports);
// File processing utilities (server-only)
__exportStar(require("./file-processor"), exports);
// Real-time and broadcasting utilities (server-only)
__exportStar(require("./broadcast-auth"), exports);
// Note: This index includes server-side dependencies and should NOT be imported
// from client-side components. Use '@pagespace/lib/client-safe' for client-side imports.
