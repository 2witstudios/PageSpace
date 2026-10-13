import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { exportFormatsFor, favoriteLabel, homePageLabel, pageActionGroups, pageActionsLabel, protectLabel, type PageActionsState } from './page-actions-model';

const base: PageActionsState = {
  pageType: 'DOCUMENT',
  isFavorite: false,
  isPrivate: false,
  isHomePage: false,
  canManageDrive: false,
  absorbHeader: false,
};

const labelsOf = (state: PageActionsState): string[][] =>
  pageActionGroups(state).map((group) => group.map((item) => item.label));

describe('pageActionGroups() (IMC-9.3)', () => {
  test('the menu is titled for the page', () => {
    assert({
      given: 'a page called Q4 Launch Plan',
      should: 'label the menu "Page actions for <title>"',
      actual: pageActionsLabel('Q4 Launch Plan'),
      expected: 'Page actions for Q4 Launch Plan',
    });
  });

  test('a document offers the tree actions in PageTreeItem order, grouped as the board groups them', () => {
    assert({
      given: 'a document the viewer cannot manage the drive of',
      should: 'list Open in new tab, child, rename, favorite, protect, permissions | select, move, copy | trash',
      actual: labelsOf(base),
      expected: [
        ['Open in new tab', 'Add child page', 'Rename', 'Favorite', 'Protect page', 'Permissions'],
        ['Select multiple', 'Move to...', 'Copy to...'],
        ['Trash'],
      ],
    });
  });

  test('the labels follow the page state', () => {
    assert({
      given: 'a favorite, protected page',
      should: 'offer Unfavorite and Unprotect page',
      actual: [favoriteLabel(true), protectLabel(true)],
      expected: ['Unfavorite', 'Unprotect page'],
    });
  });

  test('the home page item is for owners and admins only', () => {
    assert({
      given: 'a viewer who can manage the drive, on a page that is not home',
      should: 'offer Set as home page after Permissions',
      actual: labelsOf({ ...base, canManageDrive: true }).at(0)?.slice(5),
      expected: ['Permissions', 'Set as home page'],
    });
  });

  test('the home page label flips when the page is home', () => {
    assert({
      given: 'the drive home page',
      should: 'offer Remove as home page',
      actual: homePageLabel(true),
      expected: 'Remove as home page',
    });
  });

  test('absorbing the header adds Export and Print, with the formats for the page type', () => {
    assert({
      given: 'a sheet with the header flag on',
      should: 'offer an Export submenu of CSV and Excel, then Print, in their own group',
      actual: pageActionGroups({ ...base, pageType: 'SHEET', absorbHeader: true }).at(1)?.map((item) => item.label),
      expected: ['Export', 'Print'],
    });
  });

  test('the header flag off leaves Export and Print out of the menu', () => {
    assert({
      given: 'a document with the header flag off',
      should: 'not offer Export or Print',
      actual: labelsOf(base).flat().filter((label) => label === 'Export' || label === 'Print'),
      expected: [],
    });
  });

  test('a page type with no export formats has no Export even with the flag on', () => {
    assert({
      given: 'a canvas with the header flag on',
      should: 'offer no Export group',
      actual: exportFormatsFor('CANVAS'),
      expected: [],
    });
  });
});

describe('exportFormatsFor()', () => {
  test('documents export as DOCX and Markdown; sheets as CSV and Excel', () => {
    assert({
      given: 'a document and a sheet',
      should: 'name each type\'s formats',
      actual: [exportFormatsFor('DOCUMENT'), exportFormatsFor('SHEET')],
      expected: [['docx', 'markdown'], ['csv', 'xlsx']],
    });
  });
});
