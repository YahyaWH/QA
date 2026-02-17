/**
 * FR-020-010: Search by Phone Number
 * Test Case: FR020-TC-010
 * Description: Validates search by phone number
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-010: Search by Phone Number', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-010] should search by phone number', () => {
    cy.stepLog('Type phone number "+467" into search input');
    contactsPage.search('+467');
    cy.stepLog('Verify table contains the searched phone number');
    contactsPage.shouldContainInTable('+467');
  });
});
