/**
 * FR-020-013: Reset Button Functionality
 * Test Case: FR020-TC-013
 * Description: Validates that "Reset all" button clears search
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-013: Reset Button Functionality', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-013] should clear search when "Reset all" is clicked', () => {
    cy.stepLog('Type "WasteHero" into search input');
    contactsPage.search('WasteHero');
    cy.stepLog('Click "Reset all" button');
    contactsPage.clickResetAll();
    cy.stepLog('Verify search input is now empty');
    contactsPage.getSearchInputValue().then((value) => {
      expect(value).to.equal('');
    });
  });
});
