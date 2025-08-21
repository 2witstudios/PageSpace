import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth-utils';
import { exec } from 'child_process';
import { promisify } from 'util';
import { platform, homedir } from 'os';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { loggers } from '@pagespace/lib/logger-config';

const execAsync = promisify(exec);

interface DetectionResult {
  nodePath?: string;
  npmPath?: string;
  error?: string;
  platform?: string;
  detectionLog?: string[];
  foundPaths?: {
    node: string[];
    npm: string[];
  };
}

async function tryCommand(command: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(command, { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function checkPathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function expandPath(path: string): string {
  return path.replace('~', homedir());
}

function findNvmPaths(): string[] {
  const nvmDir = join(homedir(), '.nvm', 'versions', 'node');
  const paths: string[] = [];
  
  try {
    if (existsSync(nvmDir)) {
      const versions = readdirSync(nvmDir);
      for (const version of versions) {
        const nodePath = join(nvmDir, version, 'bin', 'node');
        if (checkPathExists(nodePath)) {
          paths.push(nodePath);
        }
      }
    }
  } catch {
    // Ignore errors
  }
  
  return paths;
}

export async function GET(request: NextRequest) {
  // Check authentication
  const authResult = await authenticateRequest(request);
  if (authResult.error) {
    return authResult.error;
  }

  const isWindows = platform() === 'win32';
  const results: DetectionResult = {
    platform: isWindows ? 'windows' : 'unix',
    detectionLog: [],
    foundPaths: { node: [], npm: [] }
  };
  
  const log = (message: string) => {
    results.detectionLog?.push(message);
    loggers.api.debug(`[Path Detection] ${message}`);
  };
  
  try {
    log(`Starting path detection on ${results.platform}`);
    
    // Strategy 1: Try standard commands with enhanced PATH
    log('Strategy 1: Standard commands');
    if (!isWindows) {
      // Try with enhanced PATH that includes common locations
      const enhancedPath = `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin:${homedir()}/.nvm/current/bin`;
      
      const nodeResult = await tryCommand(`PATH="${enhancedPath}" which node`);
      if (nodeResult && checkPathExists(nodeResult)) {
        results.nodePath = nodeResult;
        results.foundPaths?.node.push(nodeResult);
        log(`✓ Found Node via which: ${nodeResult}`);
      } else {
        log('✗ which node failed or path does not exist');
      }
      
      const npmResult = await tryCommand(`PATH="${enhancedPath}" npm root -g`);
      if (npmResult && checkPathExists(npmResult)) {
        results.npmPath = npmResult;
        results.foundPaths?.npm.push(npmResult);
        log(`✓ Found npm root via npm command: ${npmResult}`);
      } else {
        log('✗ npm root -g failed or path does not exist');
      }
    } else {
      // Windows commands
      const nodeResult = await tryCommand('where node');
      if (nodeResult) {
        const paths = nodeResult.split('\n').map(p => p.trim()).filter(Boolean);
        const validPath = paths.find(p => checkPathExists(p));
        if (validPath) {
          results.nodePath = validPath;
          results.foundPaths?.node.push(validPath);
          log(`✓ Found Node via where: ${validPath}`);
        }
      }
      
      const npmResult = await tryCommand('npm root -g');
      if (npmResult && checkPathExists(npmResult)) {
        results.npmPath = npmResult;
        results.foundPaths?.npm.push(npmResult);
        log(`✓ Found npm root: ${npmResult}`);
      }
    }
    
    // Strategy 2: Check common installation locations
    log('Strategy 2: Common installation locations');
    const commonPaths = isWindows ? [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
    ] : [
      '/usr/local/bin/node',
      '/opt/homebrew/bin/node', 
      '/usr/bin/node',
      '/bin/node'
    ];
    
    for (const path of commonPaths) {
      if (!results.nodePath && checkPathExists(path)) {
        results.nodePath = path;
        results.foundPaths?.node.push(path);
        log(`✓ Found Node at common location: ${path}`);
        break;
      }
    }
    
    // Strategy 3: Find NVM installations (Unix only)
    if (!isWindows && !results.nodePath) {
      log('Strategy 3: NVM installations');
      const nvmPaths = findNvmPaths();
      if (nvmPaths.length > 0) {
        // Use the latest version
        nvmPaths.sort().reverse();
        results.nodePath = nvmPaths[0];
        results.foundPaths?.node.push(...nvmPaths);
        log(`✓ Found NVM Node installations: ${nvmPaths.join(', ')}`);
        log(`✓ Using latest: ${results.nodePath}`);
      } else {
        log('✗ No NVM installations found');
      }
    }
    
    // Strategy 4: Try alternative commands
    if (!results.nodePath && !isWindows) {
      log('Strategy 4: Alternative commands');
      const alternatives = ['whereis node', 'type node', 'command -v node'];
      for (const cmd of alternatives) {
        const result = await tryCommand(cmd);
        if (result) {
          const path = result.split(' ').find(p => p.includes('/node') && checkPathExists(p));
          if (path) {
            results.nodePath = path;
            results.foundPaths?.node.push(path);
            log(`✓ Found Node via ${cmd}: ${path}`);
            break;
          }
        }
      }
    }
    
    // Strategy 5: Construct npm path from node path
    if (results.nodePath && !results.npmPath) {
      log('Strategy 5: Construct npm path from node path');
      let constructedNpmPath: string | undefined;
      
      if (isWindows) {
        if (results.nodePath.includes('Program Files')) {
          constructedNpmPath = results.nodePath.replace('\\node.exe', '\\node_modules\\npm\\node_modules');
        }
      } else {
        constructedNpmPath = results.nodePath.replace('/bin/node', '/lib/node_modules');
      }
      
      if (constructedNpmPath && checkPathExists(constructedNpmPath)) {
        results.npmPath = constructedNpmPath;
        results.foundPaths?.npm.push(constructedNpmPath);
        log(`✓ Constructed and verified npm path: ${constructedNpmPath}`);
      } else if (constructedNpmPath) {
        log(`✗ Constructed npm path does not exist: ${constructedNpmPath}`);
      }
    }
    
    // Strategy 6: Common npm global locations
    if (!results.npmPath) {
      log('Strategy 6: Common npm global locations');
      const commonNpmPaths = isWindows ? [
        'C:\\Users\\[USER]\\AppData\\Roaming\\npm\\node_modules',
        'C:\\Program Files\\nodejs\\node_modules\\npm\\node_modules'
      ] : [
        '/usr/local/lib/node_modules',
        '/opt/homebrew/lib/node_modules',
        join(homedir(), '.npm-global', 'lib', 'node_modules')
      ];
      
      for (const path of commonNpmPaths) {
        const expandedPath = expandPath(path);
        if (checkPathExists(expandedPath)) {
          results.npmPath = expandedPath;
          results.foundPaths?.npm.push(expandedPath);
          log(`✓ Found npm at common location: ${expandedPath}`);
          break;
        }
      }
    }
    
    log(`Detection complete. Node: ${results.nodePath || 'not found'}, NPM: ${results.npmPath || 'not found'}`);
    
    if (!results.nodePath && !results.npmPath) {
      return NextResponse.json({
        ...results,
        error: 'Could not detect Node.js or npm paths with any strategy.'
      }, { status: 404 });
    }
    
    return NextResponse.json(results);
  } catch (error) {
    log(`Error during detection: ${error}`);
    return NextResponse.json({ 
      ...results,
      error: 'Failed to detect paths',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}