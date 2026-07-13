/**
 * Location context prompt — the "what page/drive is the user looking at right
 * now" block, built fresh every turn and injected via the VOLATILE turn
 * context (prompt-assembly.ts), NOT the stable system prompt. This is what
 * lets the agent stay accurate as the user navigates between turns without
 * busting the provider prompt-cache prefix on every location change.
 *
 * Used by both the page-agent route (api/ai/chat) and the Global Assistant
 * route (api/ai/global/[id]/messages) so the two surfaces share one source
 * of truth for this text instead of drifting.
 */

export interface LocationPromptInput {
  currentPage?: {
    title: string;
    type: string;
    path: string;
    isTaskLinked?: boolean;
  } | null;
  currentDrive?: {
    name: string;
    slug?: string;
    id?: string;
  } | null;
  breadcrumbs?: string[];
}

export function buildLocationTurnPrompt(input: LocationPromptInput | undefined): string {
  if (!input || (!input.currentPage && !input.currentDrive)) {
    return `LOCATION (current, this turn):
• Operating from the dashboard — no specific workspace or page is currently in view
• Use list_drives to discover available workspaces before suggesting new drive creation
• When the user says "here" or "this", ask which workspace/page they mean, or use list_drives/list_pages to find out`;
  }

  const lines: string[] = ['LOCATION (current, this turn):'];

  if (input.currentPage) {
    lines.push(`• Current page: "${input.currentPage.title}" [${input.currentPage.type}] at ${input.currentPage.path}`);
    if (input.currentPage.isTaskLinked) {
      lines.push(`• This page is linked to a task — use task management tools to update task status`);
    }
  }

  if (input.currentDrive) {
    const slugPart = input.currentDrive.slug ? `, slug: ${input.currentDrive.slug}` : '';
    const idPart = input.currentDrive.id ? `, driveId: ${input.currentDrive.id}` : '';
    lines.push(`• Current workspace: "${input.currentDrive.name}"${slugPart}${idPart}`);
  }

  if (input.breadcrumbs?.length) {
    lines.push(`• Path: ${input.breadcrumbs.join(' > ')}`);
  }

  lines.push('• When the user says "here" or "this", they mean the location above');
  lines.push('• Default scope: operations should focus on this location unless the user indicates otherwise');

  if (input.currentDrive?.id) {
    lines.push('• Start with list_pages on this drive (driveId above) before exploring elsewhere');
  }

  return lines.join('\n');
}
