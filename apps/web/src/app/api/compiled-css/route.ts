import { promises as fs } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/server';

export async function GET() {
  try {
    // Construct the path to globals.css relative to the current file
    const cssPath = path.join(process.cwd(), 'src', 'app', 'globals.css');
    
    // Read the file content
    const css = await fs.readFile(cssPath, 'utf-8');
    
    // Return the CSS content with the correct content-type header
    return new NextResponse(css, {
      headers: {
        'Content-Type': 'text/css',
      },
    });
  } catch (error) {
    loggers.api.error('Failed to read globals.css:', error as Error);
    return new NextResponse('/* Failed to load compiled CSS */', {
      status: 500,
      headers: {
        'Content-Type': 'text/css',
      },
    });
  }
}