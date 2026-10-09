import { expect, type Page, type Locator } from '@playwright/test';

/** The retained task toolbar uses direct controls in wide panes and a sheet in narrow panes. */
export async function selectTaskFilter(page: Page, name: 'All' | 'Active' | 'Completed'): Promise<void> {
  const object = page.locator('[data-slot="object"]');
  const direct = object.getByRole('button', { name, exact: true });
  const filters = object.getByRole('button', { name: /^Filters/ });
  await expect(direct.or(filters).first()).toBeVisible();
  if (await direct.isVisible()) {
    await direct.click();
  } else {
    await filters.click();
    await page.getByRole('dialog', { name: 'Filters', exact: true }).getByRole('button', { name, exact: true }).click();
  }
}

export async function openTaskConfiguration(page: Page, name: 'Statuses' | 'Workflows'): Promise<void> {
  const sheet = page.getByRole('dialog', { name: 'Filters', exact: true });
  const object = page.locator('[data-slot="object"]');
  const direct = object.getByRole('button', { name, exact: true });
  const filters = object.getByRole('button', { name: /^Filters/ });
  const inSheet = sheet.getByRole('button', { name, exact: true });
  // Closing a nested configuration dialog restores the Filters sheet asynchronously.
  await expect(inSheet.or(direct).or(filters).first()).toBeVisible();
  if (await inSheet.isVisible()) {
    await inSheet.click();
    return;
  }
  if (await direct.isVisible()) {
    await direct.click();
  } else {
    await filters.click();
    await sheet.getByRole('button', { name, exact: true }).click();
  }
}

/** The same task actions are a row menu in wide panes and a detail sheet in narrow panes. */
export async function openTaskActions(page: Page, taskId: string, title: string): Promise<Locator> {
  const object = page.locator('[data-slot="object"]');
  await object.getByRole('button', { name: 'Table view', exact: true }).click();
  const row = object.locator(`[data-task-id="${taskId}"]:visible`);
  await expect(row).toBeVisible();
  const actions = row.getByRole('button', { name: `Actions for ${title}`, exact: true });
  if (await actions.isVisible()) {
    await actions.click();
    return page.getByRole('menu');
  }
  await row.getByRole('button').filter({ hasText: title }).click();
  const details = page.getByRole('dialog', { name: 'Task Details', exact: true });
  await expect(details).toBeVisible();
  return details;
}
