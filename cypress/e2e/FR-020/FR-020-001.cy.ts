/**
 * FR-020-001: Search Input Display
 * Test Case: FR020-TC-001
 * Description: Validates that search input is visible in toolbar
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-001: Search Input Display', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-001] should display search input in toolbar', () => {
    cy.stepLog('Verify search input element is visible in the toolbar');
    contactsPage.shouldShowSearchInput();

    cy.stepLog('Confirm search input is ready for user interaction');
  });
});
