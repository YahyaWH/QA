/**
 * FR-020-004: Search Input Typing
 * Test Case: FR020-TC-004
 * Description: Validates that user can type in search input
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-004: Search Input Typing', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-004] should allow typing in search input', () => {
    cy.stepLog('Type "WasteHero" into search input');
    contactsPage.search('WasteHero');
    cy.stepLog('Verify search input contains "WasteHero"');
    contactsPage.shouldHaveSearchValue('WasteHero');
  });
});
