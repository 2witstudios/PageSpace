/**
 * Test file to verify enhanced AI prompts are working correctly
 */

import { RolePromptBuilder } from './role-prompts';
import { AgentRole } from './agent-roles';

// Test function to generate and display prompts
export function testEnhancedPrompts() {
  console.log('='.repeat(80));
  console.log('TESTING ENHANCED PAGESPACE AI PROMPTS');
  console.log('='.repeat(80));

  // Test PARTNER role prompt
  console.log('\n' + '='.repeat(40));
  console.log('PARTNER ROLE - Collaborative AI');
  console.log('='.repeat(40));
  const partnerPrompt = RolePromptBuilder.buildSystemPrompt(
    AgentRole.PARTNER,
    'drive',
    {
      driveName: 'Marketing Projects',
      driveSlug: 'marketing',
      driveId: 'clq2n3x4m0001',
    }
  );
  console.log(partnerPrompt.substring(0, 1500) + '...\n');

  // Test PLANNER role prompt
  console.log('='.repeat(40));
  console.log('PLANNER ROLE - Strategic Assistant');
  console.log('='.repeat(40));
  const plannerPrompt = RolePromptBuilder.buildSystemPrompt(
    AgentRole.PLANNER,
    'page',
    {
      pagePath: '/projects/q4-planning/roadmap',
      pageType: 'DOCUMENT',
      breadcrumbs: ['Projects', 'Q4 Planning', 'Roadmap'],
    }
  );
  console.log(plannerPrompt.substring(0, 1500) + '...\n');

  // Test WRITER role prompt
  console.log('='.repeat(40));
  console.log('WRITER ROLE - Execution Focused');
  console.log('='.repeat(40));
  const writerPrompt = RolePromptBuilder.buildSystemPrompt(
    AgentRole.WRITER,
    'dashboard',
  );
  console.log(writerPrompt.substring(0, 1500) + '...\n');

  // Test specific sections
  console.log('='.repeat(40));
  console.log('KEY IMPROVEMENTS VERIFICATION');
  console.log('='.repeat(40));

  const improvements = [
    'PARALLELIZE operations',
    'list_drives → list_pages → read_page',
    'batch_page_operations',
    'ERROR RECOVERY',
    'ALWAYS READ BEFORE WRITE',
    'create_task_list',
    'regex_search',
    'glob_search',
  ];

  improvements.forEach(improvement => {
    const found = partnerPrompt.includes(improvement);
    console.log(`✓ ${improvement}: ${found ? '✅ FOUND' : '❌ MISSING'}`);
  });

  // Count tool instruction sections
  const toolSections = [
    'WORKSPACE NAVIGATION PATTERN',
    'DOCUMENT OPERATIONS',
    'SEARCH STRATEGIES',
    'TASK MANAGEMENT',
    'BATCH OPERATIONS',
    'PARALLEL EXECUTION',
    'ERROR RECOVERY',
  ];

  console.log('\n' + '='.repeat(40));
  console.log('TOOL INSTRUCTION SECTIONS');
  console.log('='.repeat(40));

  toolSections.forEach(section => {
    const found = partnerPrompt.includes(section);
    console.log(`${found ? '✅' : '❌'} ${section}`);
  });

  console.log('\n' + '='.repeat(80));
  console.log('PROMPT LENGTH ANALYSIS');
  console.log('='.repeat(80));
  console.log(`Partner Prompt Length: ${partnerPrompt.length} characters`);
  console.log(`Planner Prompt Length: ${plannerPrompt.length} characters`);
  console.log(`Writer Prompt Length: ${writerPrompt.length} characters`);

  return {
    partnerPrompt,
    plannerPrompt,
    writerPrompt,
  };
}

// Run test if this file is executed directly
if (require.main === module) {
  testEnhancedPrompts();
}