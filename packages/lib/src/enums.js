"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubjectType = exports.PermissionAction = exports.PageType = void 0;
var PageType;
(function (PageType) {
    PageType["FOLDER"] = "FOLDER";
    PageType["DOCUMENT"] = "DOCUMENT";
    PageType["CHANNEL"] = "CHANNEL";
    PageType["AI_CHAT"] = "AI_CHAT";
    PageType["CANVAS"] = "CANVAS";
    PageType["FILE"] = "FILE";
    PageType["SHEET"] = "SHEET";
})(PageType || (exports.PageType = PageType = {}));
var PermissionAction;
(function (PermissionAction) {
    PermissionAction["VIEW"] = "VIEW";
    PermissionAction["EDIT"] = "EDIT";
    PermissionAction["SHARE"] = "SHARE";
    PermissionAction["DELETE"] = "DELETE";
})(PermissionAction || (exports.PermissionAction = PermissionAction = {}));
var SubjectType;
(function (SubjectType) {
    SubjectType["USER"] = "USER";
})(SubjectType || (exports.SubjectType = SubjectType = {}));
