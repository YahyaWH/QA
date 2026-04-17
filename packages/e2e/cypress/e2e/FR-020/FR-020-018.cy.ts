/**
 * FR-020-018: Filter Button Presence
 * Test Case: FR020-TC-018
 * Description: Validates that filter button is displayed
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-018: Filter Button Presence', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-018] should have filter button', () => {
    cy.stepLog('Verify filter button with icon exists');
    cy.get('button').find('svg').should('exist');
  });
});
