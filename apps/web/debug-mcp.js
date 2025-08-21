#!/usr/bin/env node

import { db, mcpTokens, users, drives, eq, isNull, and } from '@pagespace/db';

async function debugMCP() {
  try {
    console.log('=== MCP Token Debug ===');
    
    const token = 'mcp_XHJyu4mzqJjj6_-vGFeuzDgwMBx1fowuKYS5w8-LKZs';
    
    // 1. Check what user this token belongs to
    const tokenData = await db.query.mcpTokens.findFirst({
      where: and(
        eq(mcpTokens.token, token),
        isNull(mcpTokens.revokedAt)
      ),
    });
    
    if (!tokenData) {
      console.log('❌ Token not found in database');
      return;
    }
    
    console.log('✅ Token found:');
    console.log('  Token ID:', tokenData.id);
    console.log('  User ID:', tokenData.userId);
    console.log('  Name:', tokenData.name);
    console.log('  Created:', tokenData.createdAt);
    console.log('  Last Used:', tokenData.lastUsed);
    
    // 2. Get user details
    const user = await db.query.users.findFirst({
      where: eq(users.id, tokenData.userId),
    });
    
    if (user) {
      console.log('\n✅ User found:');
      console.log('  User ID:', user.id);
      console.log('  Username:', user.username);
      console.log('  Email:', user.email);
    } else {
      console.log('\n❌ User not found');
    }
    
    // 3. Get drives owned by this user
    const userDrives = await db.query.drives.findMany({
      where: eq(drives.ownerId, tokenData.userId),
    });
    
    console.log('\n=== Drives owned by this user ===');
    if (userDrives.length === 0) {
      console.log('❌ No drives found for this user');
    } else {
      console.log(`✅ Found ${userDrives.length} drives:`);
      userDrives.forEach(drive => {
        console.log(`  - ${drive.name} (${drive.slug}) - ID: ${drive.id}`);
      });
    }
    
    // 4. Get ALL drives for comparison
    const allDrives = await db.query.drives.findMany();
    console.log('\n=== All drives in database ===');
    console.log(`Total drives: ${allDrives.length}`);
    allDrives.forEach(drive => {
      console.log(`  - ${drive.name} (${drive.slug}) - Owner: ${drive.ownerId} - ID: ${drive.id}`);
    });
    
    // 5. Get ALL users for comparison
    const allUsers = await db.query.users.findMany();
    console.log('\n=== All users in database ===');
    console.log(`Total users: ${allUsers.length}`);
    allUsers.forEach(user => {
      console.log(`  - ${user.username} (${user.email}) - ID: ${user.id}`);
    });
    
  } catch (error) {
    console.error('Error:', error);
  }
  
  process.exit(0);
}

debugMCP();