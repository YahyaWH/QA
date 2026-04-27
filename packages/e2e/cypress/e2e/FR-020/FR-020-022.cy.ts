/**
 * FR-020-022: Search Performance
 * Test Case: FR020-TC-022
 * Description: Validates that search responds within 3 seconds
 */

import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('FR-020-022: Search Performance', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Contacts page');
    setupContactsTest();
  });

  it('[FR020-TC-022] should respond to search quickly', () => {
    cy.stepLog('Start performance timer');
    const startTime = Date.now();

    cy.stepLog('Type "WasteHero" and measure response time');
    contactsPage.search('WasteHero');
    contactsPage.shouldContainInTable('WasteHero');

    cy.then(() => {
      const duration = Date.now() - startTime;
      cy.stepLog(`Search completed in ${duration}ms`);
      cy.stepLog('Verify search completed within 3 seconds');
      expect(duration).to.be.lessThan(3000);
    });
  });
});
