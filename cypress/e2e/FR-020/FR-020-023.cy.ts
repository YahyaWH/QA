/**
 * FR-020-023: Page Navigation Regression
 * Test Case: FR020-TC-023
 * Description: Validates search doesn't break when navigating between pages
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-023: Page Navigation Regression', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-023] should not break when switching pages', () => {
    cy.stepLog('Type "WasteHero" into search input');
    contactsPage.search('WasteHero');

    cy.stepLog('Navigate away to Properties page');
    cy.contains('Properties').click();
    cy.wait(1000);

    cy.stepLog('Navigate back to Contacts page');
    cy.contains('Contacts').click();
    cy.wait(1000);

    cy.stepLog('Verify search input still works after navigation');
    contactsPage.shouldShowSearchInput();
  });
});
