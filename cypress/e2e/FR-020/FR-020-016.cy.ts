/**
 * FR-020-016: Pagination Support
 * Test Case: FR020-TC-016
 * Description: Validates that table supports pagination
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-016: Pagination Support', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-016] should support pagination', () => {
    cy.stepLog('Verify pagination controls are visible');
    contactsPage.shouldShowPagination();
    cy.stepLog('Verify pagination buttons exist');
    cy.get('button').should('exist');
  });
});
