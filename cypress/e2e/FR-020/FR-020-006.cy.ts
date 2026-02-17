/**
 * FR-020-006: Case-Insensitive Search
 * Test Case: FR020-TC-006
 * Description: Validates that search is case-insensitive
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-006: Case-Insensitive Search', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-006] should be case-insensitive', () => {
    cy.stepLog('Type lowercase "wastehero" into search input');
    contactsPage.search('wastehero');
    cy.stepLog('Verify table contains "WasteHero" (case-insensitive match)');
    contactsPage.shouldContainInTable('WasteHero');
  });
});
