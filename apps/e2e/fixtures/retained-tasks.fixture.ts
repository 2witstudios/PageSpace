import { expect, type Page } from '@playwright/test';

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
  // Status categories use a nested dialog; closing it returns to this sheet.
  if (await sheet.isVisible()) {
    await sheet.getByRole('button', { name, exact: true }).click();
    return;
  }
  const object = page.locator('[data-slot="object"]');
  const direct = object.getByRole('button', { name, exact: true });
  const filters = object.getByRole('button', { name: /^Filters/ });
  await expect(direct.or(filters).first()).toBeVisible();
  if (await direct.isVisible()) {
    await direct.click();
  } else {
    await filters.click();
    await sheet.getByRole('button', { name, exact: true }).click();
  }
}
