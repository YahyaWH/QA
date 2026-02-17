/**
 * FR-020-019: Search and Filter Integration
 * Test Case: FR020-TC-019
 * Description: Validates search works together with filters
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-019: Search and Filter Integration', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-019] should work with search and filters together', () => {
    cy.stepLog('Type "Municipality" into search input');
    contactsPage.search('Municipality');
    cy.stepLog('Verify table contains "Municipality" with search and filter integration');
    contactsPage.shouldContainInTable('Municipality');
  });
});
