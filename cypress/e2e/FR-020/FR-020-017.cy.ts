/**
 * FR-020-017: Row Selection Checkboxes
 * Test Case: FR020-TC-017
 * Description: Validates that table rows have selection checkboxes
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-017: Row Selection Checkboxes', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-017] should allow selecting rows with checkboxes', () => {
    cy.stepLog('Verify first table row has a selection checkbox');
    cy.get('table tbody tr').first().find('input[type="checkbox"]').should('exist');
  });
});
