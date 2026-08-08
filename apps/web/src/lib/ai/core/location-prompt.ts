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
    /**
     * The page's id. Rendered so the model can address this page directly in
     * tool calls instead of only by title — titles are ambiguous across
     * drives and change under the model's feet when a page is renamed.
     */
    id?: string;
    title: string;
    type: string;
    path: string;
  } | null;
  currentDrive?: {
    name: string;
    slug?: string;
    id?: string;
  } | null;
  breadcrumbs?: string[];
  /**
   * The sender's Home drive id, rendered only in the no-location branch.
   * list_drives returns neither drive kind nor a Home marker, so without this
   * an agent standing nowhere has no way to name Home — which the /plan skill
   * needs as the destination for a personal plan artifact. Exposed as data
   * only: the "do NOT assume the Home drive" rule below still governs general
   * content creation, and a skill that wants Home must say so explicitly.
   */
  homeDriveId?: string | null;
}

export function buildLocationTurnPrompt(input: LocationPromptInput | undefined): string {
  if (!input || (!input.currentPage && !input.currentDrive)) {
    // The guard and the hint have to be worded as one rule, not two adjacent
    // ones. "Do NOT assume the Home drive" followed immediately by the Home
    // driveId reads as a contradiction the model has to resolve on its own —
    // and resolving it the wrong way is exactly the bug the guard was added to
    // prevent (agents dumping content into Home instead of the user's
    // workspace). So the guard is scoped to general work, and the id is
    // labelled as reference data that is off-limits unless something names it.
    const homeLine = input?.homeDriveId
      ? `\n• Home drive reference (private to this user), driveId: ${input.homeDriveId} — do NOT write here unless a loaded skill or the user explicitly names Home as the destination`
      : '';
    return `LOCATION (current, this turn):
• Operating from the dashboard — no specific workspace or page is currently in view
• Use list_drives to discover available workspaces before suggesting new drive creation
• When the user says "here" or "this", ask which workspace/page they mean, or use list_drives/list_pages to find out
• Do NOT default to the Home drive for general work — ask which workspace, or use list_drives${homeLine}`;
  }

  const lines: string[] = ['LOCATION (current, this turn):'];

  if (input.currentPage) {
    const idPart = input.currentPage.id ? ` — pageId: ${input.currentPage.id}` : '';
    lines.push(`• Current page: "${input.currentPage.title}" [${input.currentPage.type}] at ${input.currentPage.path}${idPart}`);
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
    lines.push('• Omit driveId on create_page, list_pages, glob_search, regex_search and generate_image to act on THIS workspace — never substitute a different drive, and never the Home drive, unless the user names one');
  }

  return lines.join('\n');
}
