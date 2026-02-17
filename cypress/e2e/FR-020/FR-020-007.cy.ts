/**
 * FR-020-007: Partial Match Search
 * Test Case: FR020-TC-007
 * Description: Validates that search supports partial matches
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-007: Partial Match Search', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-007] should support partial matches', () => {
    cy.stepLog('Type partial search term "Waste" into search input');
    contactsPage.search('Waste');
    cy.stepLog('Verify table contains "WasteHero" from partial match');
    contactsPage.shouldContainInTable('WasteHero');
  });
});
