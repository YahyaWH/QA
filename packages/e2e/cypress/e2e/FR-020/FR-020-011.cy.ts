/**
 * FR-020-011: No Results Display
 * Test Case: FR020-TC-011
 * Description: Validates "no results" message for non-existent search
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-011: No Results Display', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-011] should show no results for non-existent search', () => {
    cy.stepLog('Type non-existent search term "xyznonexistent123"');
    contactsPage.search('xyznonexistent123');
    cy.stepLog('Verify "no data" message is displayed');
    contactsPage.shouldShowNoData();
  });
});
