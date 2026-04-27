/**
 * FR-020-009: Search by Customer Name
 * Test Case: FR020-TC-009
 * Description: Validates search by customer name
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-009: Search by Customer Name', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-009] should search by customer name', () => {
    cy.stepLog('Type customer name "asdf" into search input');
    contactsPage.search('asdf');
    cy.stepLog('Verify table contains the searched customer name');
    contactsPage.shouldContainInTable('asdf');
  });
});
