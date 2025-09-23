/**
 * Test file to verify enhanced AI prompts are working correctly
 */

import { RolePromptBuilder } from './role-prompts';
import { AgentRole } from './agent-roles';
import { loggers } from '@pagespace/lib/logger-config';

const isTestLoggingEnabled = process.env.AI_DEBUG_LOGGING === 'true';

function createPromptMetadata(prompt: string): object {
  return {
    length: prompt.length,
    wordCount: prompt.split(/\s+/).length,
    preview: `[PROMPT_REDACTED:${prompt.length}chars]`
  };
}

function testLog(message: string, data?: object): void {
  if (isTestLoggingEnabled) {
    if (data) {
      loggers.ai.debug(message, data);
    } else {
      loggers.ai.debug(message);
    }
  }
}

// Test function to generate and display prompts
export function testEnhancedPrompts() {
  testLog('='.repeat(80));
  testLog('TESTING ENHANCED PAGESPACE AI PROMPTS');
  testLog('='.repeat(80));

  // Test PARTNER role prompt
  testLog('\n' + '='.repeat(40));
  testLog('PARTNER ROLE - Collaborative AI');
  testLog('='.repeat(40));
  const partnerPrompt = RolePromptBuilder.buildSystemPrompt(
    AgentRole.PARTNER,
    'drive',
    {
      driveName: 'Marketing Projects',
      driveSlug: 'marketing',
      driveId: 'clq2n3x4m0001',
    }
  );
  testLog('Partner prompt generated', createPromptMetadata(partnerPrompt));

  // Test PLANNER role prompt
  testLog('='.repeat(40));
  testLog('PLANNER ROLE - Strategic Assistant');
  testLog('='.repeat(40));
  const plannerPrompt = RolePromptBuilder.buildSystemPrompt(
    AgentRole.PLANNER,
    'page',
    {
      pagePath: '/projects/q4-planning/roadmap',
      pageType: 'DOCUMENT',
      breadcrumbs: ['Projects', 'Q4 Planning', 'Roadmap'],
    }
  );
  testLog('Planner prompt generated', createPromptMetadata(plannerPrompt));

  // Test WRITER role prompt
  testLog('='.repeat(40));
  testLog('WRITER ROLE - Execution Focused');
  testLog('='.repeat(40));
  const writerPrompt = RolePromptBuilder.buildSystemPrompt(
    AgentRole.WRITER,
    'dashboard',
  );
  testLog('Writer prompt generated', createPromptMetadata(writerPrompt));

  // Test specific sections
  testLog('='.repeat(40));
  testLog('KEY IMPROVEMENTS VERIFICATION');
  testLog('='.repeat(40));

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

  const improvementResults = improvements.map(improvement => {
    const found = partnerPrompt.includes(improvement);
    return { improvement, found };
  });

  testLog('Improvements verification', { results: improvementResults });

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

  testLog('\n' + '='.repeat(40));
  testLog('TOOL INSTRUCTION SECTIONS');
  testLog('='.repeat(40));

  const sectionResults = toolSections.map(section => {
    const found = partnerPrompt.includes(section);
    return { section, found };
  });

  testLog('Tool instruction sections verification', { results: sectionResults });

  testLog('\n' + '='.repeat(80));
  testLog('PROMPT LENGTH ANALYSIS');
  testLog('='.repeat(80));

  const lengthAnalysis = {
    partnerPromptLength: partnerPrompt.length,
    plannerPromptLength: plannerPrompt.length,
    writerPromptLength: writerPrompt.length
  };

  testLog('Prompt length analysis', lengthAnalysis);

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