/**
 * FR-020-014: Table Data Display
 * Test Case: FR020-TC-014
 * Description: Validates that customer data is displayed in table
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-014: Table Data Display', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-014] should display customer data in table', () => {
    cy.stepLog('Verify customer data table is visible');
    contactsPage.shouldShowTable();
    cy.stepLog('Verify table has "Customer Name" column');
    cy.get('table thead').should('contain', 'Customer Name');
    cy.stepLog('Verify table has "Primary Contact" column');
    cy.get('table thead').should('contain', 'Primary Contact');
  });
});
