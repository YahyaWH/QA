/**
 * FR-020-020: Action Dropdown Presence
 * Test Case: FR020-TC-020
 * Description: Validates that Action dropdown is displayed
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-020: Action Dropdown Presence', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-020] should have Action dropdown', () => {
    cy.stepLog('Verify Action dropdown is visible on the page');
    contactsPage.shouldShowActionDropdown();
  });
});
