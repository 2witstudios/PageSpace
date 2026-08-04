/**
 * The /help answer for a "solo" invocation (the chip with no other text):
 * loads the sender's actual precedence-resolved command list and formats it
 * as a direct reply, with no model involved. Shared by every entry point
 * that can short-circuit a solo /help (page chat, global assistant, channel
 * agent mentions) so the wording and data source never drift apart.
 */

import { buildHelpAnswerText } from '@pagespace/lib/commands/command-core';
import { loadAvailableCommands } from '@/lib/commands/available-commands';

export async function loadHelpAnswerText(
  senderId: string,
  driveId: string | null
): Promise<string> {
  const { winners } = await loadAvailableCommands(senderId, driveId);
  return buildHelpAnswerText({ availableCommands: winners });
}
