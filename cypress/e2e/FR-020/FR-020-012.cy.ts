/**
 * FR-020-012: Reset Button Presence
 * Test Case: FR020-TC-012
 * Description: Validates that "Reset all" button is displayed
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-012: Reset Button Presence', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-012] should have "Reset all" button', () => {
    cy.stepLog('Verify "Reset all" button is visible on the page');
    contactsPage.shouldShowResetButton();
  });
});
