#!/usr/bin/env node

/**
 * AST-based script to detect unauthenticated fetch calls in client-side code
 *
 * This script parses TypeScript/JavaScript files and identifies fetch() calls
 * that should be using fetchWithAuth() for CSRF-protected API endpoints.
 *
 * Usage: node scripts/check-fetch-auth.js
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('@typescript-eslint/typescript-estree');

// Directories to scan
const SCAN_DIRS = [
  'apps/web/src/components',
  'apps/web/src/hooks',
  'apps/web/src/stores',
  'apps/web/src/lib/editor',
  'apps/web/src/app/(dashboard)',
];

// Directories/files to exclude
const EXCLUDE_PATTERNS = [
  /\/app\/api\//,              // Server-side API routes
  /\/middleware\//,            // Server-side middleware
  /auth-fetch\.ts$/,          // The fetchWithAuth implementation itself
  /client-tracker\.ts$/,      // Uses post() wrapper
  /socket-utils\.ts$/,        // Internal service calls
  /model-capabilities\.ts$/,  // External API calls
];

// Auth flow files that should use native fetch
const AUTH_FLOW_FILES = [
  'use-auth.ts',
  'auth-store.ts',
  'use-token-refresh.ts',
  'socketStore.ts',
  'signin/page.tsx',
  'signup/page.tsx',
];

// Auth endpoints that don't require CSRF
const AUTH_ENDPOINTS = [
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/refresh',
  '/api/auth/me',
  '/api/auth/google/signin',
  '/api/auth/google/callback',
];

// Results storage
const results = {
  violations: [],
  authFlowCalls: [],
  wrapperUsage: [],
  totalFiles: 0,
  scannedFiles: 0,
};

/**
 * Check if a file should be excluded from scanning
 */
function shouldExcludeFile(filePath) {
  // Check exclusion patterns
  if (EXCLUDE_PATTERNS.some(pattern => pattern.test(filePath))) {
    return true;
  }

  // Check if it's an auth flow file
  if (AUTH_FLOW_FILES.some(file => filePath.endsWith(file))) {
    return false; // We want to scan these but mark them differently
  }

  return false;
}

/**
 * Check if a file is an auth flow file
 */
function isAuthFlowFile(filePath) {
  return AUTH_FLOW_FILES.some(file => filePath.endsWith(file));
}

/**
 * Recursively get all .ts, .tsx, .js, .jsx files
 */
function getFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);

  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // Skip node_modules and .next
      if (file !== 'node_modules' && file !== '.next' && file !== 'dist') {
        getFiles(filePath, fileList);
      }
    } else if (/\.(tsx?|jsx?)$/.test(file)) {
      fileList.push(filePath);
    }
  });

  return fileList;
}

/**
 * Check if a call expression is a fetch call
 */
function isFetchCall(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'fetch'
  );
}

/**
 * Check if a call expression is fetchWithAuth or a wrapper (post, patch, etc.)
 */
function isAuthenticatedCall(node) {
  if (node.type !== 'CallExpression') return false;

  const calleeName = node.callee.type === 'Identifier'
    ? node.callee.name
    : node.callee.type === 'MemberExpression' && node.callee.property
      ? node.callee.property.name
      : null;

  const authenticatedCalls = ['fetchWithAuth', 'post', 'patch', 'del', 'put'];
  return authenticatedCalls.includes(calleeName);
}

/**
 * Check if this is an authFetch.fetch call (AI SDK transport)
 */
function isAuthFetchWrapper(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'authFetch' &&
    node.callee.property.name === 'fetch'
  );
}

/**
 * Extract the URL from a fetch call if it's a string literal
 */
function extractUrl(node) {
  if (!node.arguments || node.arguments.length === 0) return null;

  const firstArg = node.arguments[0];

  if (firstArg.type === 'Literal' && typeof firstArg.value === 'string') {
    return firstArg.value;
  }

  if (firstArg.type === 'TemplateLiteral' && firstArg.quasis.length === 1) {
    return firstArg.quasis[0].value.raw;
  }

  return null;
}

/**
 * Check if a URL is an auth endpoint
 */
function isAuthEndpoint(url) {
  if (!url) return false;
  return AUTH_ENDPOINTS.some(endpoint => url.includes(endpoint));
}

/**
 * Traverse AST and find fetch calls
 */
function traverseNode(node, filePath, line = 1) {
  if (!node || typeof node !== 'object') return;

  // Check for fetch() calls
  if (isFetchCall(node)) {
    const url = extractUrl(node);
    const location = `${filePath}:${node.loc?.start.line || line}`;

    if (isAuthFlowFile(filePath) || isAuthEndpoint(url)) {
      // Auth flow - expected to use native fetch
      results.authFlowCalls.push({
        file: filePath,
        line: node.loc?.start.line || line,
        url: url || '(dynamic)',
        reason: isAuthEndpoint(url) ? 'auth endpoint' : 'auth flow file',
      });
    } else {
      // Potential violation - client code using native fetch
      results.violations.push({
        file: filePath,
        line: node.loc?.start.line || line,
        url: url || '(dynamic)',
        type: 'native fetch()',
      });
    }
  }

  // Check for authenticated wrapper usage
  if (isAuthenticatedCall(node)) {
    results.wrapperUsage.push({
      file: filePath,
      line: node.loc?.start.line || line,
      wrapper: node.callee.name,
    });
  }

  if (isAuthFetchWrapper(node)) {
    results.wrapperUsage.push({
      file: filePath,
      line: node.loc?.start.line || line,
      wrapper: 'authFetch.fetch',
    });
  }

  // Traverse child nodes
  for (const key in node) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;

    const child = node[key];

    if (Array.isArray(child)) {
      child.forEach(item => traverseNode(item, filePath, node.loc?.start.line || line));
    } else if (child && typeof child === 'object') {
      traverseNode(child, filePath, node.loc?.start.line || line);
    }
  }
}

/**
 * Analyze a single file
 */
function analyzeFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Parse with TypeScript ESTree
    const ast = parse(content, {
      loc: true,
      range: true,
      jsx: true,
      sourceType: 'module',
      ecmaVersion: 2022,
    });

    traverseNode(ast, filePath);
    results.scannedFiles++;
  } catch (error) {
    console.error(`Error parsing ${filePath}:`, error.message);
  }
}

/**
 * Main execution
 */
function main() {
  console.log('🔍 Scanning for unauthenticated fetch calls...\n');

  const rootDir = path.join(__dirname, '..');

  // Collect all files to scan
  const allFiles = [];
  SCAN_DIRS.forEach(dir => {
    const fullPath = path.join(rootDir, dir);
    if (fs.existsSync(fullPath)) {
      const files = getFiles(fullPath);
      allFiles.push(...files);
    }
  });

  results.totalFiles = allFiles.length;

  // Filter and analyze files
  allFiles
    .filter(file => !shouldExcludeFile(file))
    .forEach(file => analyzeFile(file));

  // Print results
  console.log('📊 Results:\n');
  console.log(`Total files found: ${results.totalFiles}`);
  console.log(`Files scanned: ${results.scannedFiles}`);
  console.log(`Authenticated wrapper usage: ${results.wrapperUsage.length}`);
  console.log(`Auth flow fetch calls: ${results.authFlowCalls.length}`);
  console.log(`Potential violations: ${results.violations.length}\n`);

  if (results.violations.length > 0) {
    console.log('⚠️  VIOLATIONS FOUND:\n');
    console.log('The following files use native fetch() and should likely use fetchWithAuth():\n');

    results.violations.forEach(violation => {
      console.log(`  ${violation.file}:${violation.line}`);
      console.log(`    URL: ${violation.url}`);
      console.log(`    Type: ${violation.type}\n`);
    });

    console.log('💡 Tip: Make sure these are not auth flows or external API calls.\n');
    process.exit(1);
  }

  if (results.authFlowCalls.length > 0) {
    console.log('✅ Auth Flow Calls (expected to use native fetch):\n');
    results.authFlowCalls.forEach(call => {
      console.log(`  ${call.file}:${call.line} - ${call.url} (${call.reason})`);
    });
    console.log();
  }

  console.log('✅ All client-side fetch calls are properly authenticated!\n');
  console.log(`Found ${results.wrapperUsage.length} uses of fetchWithAuth/post/patch/del`);

  process.exit(0);
}

// Run the script
main();
