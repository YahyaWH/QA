/**
 * FR-020-005: Search Table Filtering
 * Test Case: FR020-TC-005
 * Description: Validates that table filters when searching
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-005: Search Table Filtering', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-005] should filter table when searching', () => {
    cy.stepLog('Get initial row count from table');
    contactsPage.getRowCount().then((initialCount) => {
      cy.stepLog(`Initial row count: ${initialCount}`);
      cy.stepLog('Type "WasteHero" into search input');
      contactsPage.search('WasteHero');
      cy.stepLog('Verify table contains "WasteHero" after filtering');
      contactsPage.shouldContainInTable('WasteHero');
    });
  });
});
