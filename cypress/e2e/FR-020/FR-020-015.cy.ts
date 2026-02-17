/**
 * FR-020-015: Actionable Rows
 * Test Case: FR020-TC-015
 * Description: Validates that table rows have actionable elements
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-015: Actionable Rows', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-015] should have actionable rows', () => {
    cy.stepLog('Verify first table row is visible');
    cy.get('table tbody tr').first().should('be.visible');
    cy.stepLog('Verify row has "View" action button');
    cy.get('table tbody tr').first().contains('button', 'View').should('exist');
  });
});
