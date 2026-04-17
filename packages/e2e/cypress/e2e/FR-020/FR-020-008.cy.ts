/**
 * FR-020-008: Clear Search Functionality
 * Test Case: FR020-TC-008
 * Description: Validates that clearing search input restores all results
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-008: Clear Search Functionality', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-008] should clear search when input is cleared', () => {
    cy.stepLog('Get initial row count from table');
    contactsPage.getRowCount().then((initialCount) => {
      cy.stepLog(`Initial row count: ${initialCount}`);
      cy.stepLog('Type "WasteHero" to filter the table');
      contactsPage.search('WasteHero');

      contactsPage.getRowCount().then((filteredCount) => {
        cy.stepLog(`Filtered row count: ${filteredCount}`);
        cy.stepLog('Clear search input');
        contactsPage.clearSearch();
        cy.stepLog('Verify row count is greater than filtered count');
        contactsPage.shouldHaveRowCountGreaterThan(filteredCount);
      });
    });
  });
});
