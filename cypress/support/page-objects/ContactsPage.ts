/**
 * Page Object Model for Contacts Page
 * URL: /app/customer-management/contacts
 * Navigation: Customers (sidebar) → Contacts (submenu)
 */

export class ContactsPage {
  // Selectors
  private readonly searchInput = 'input[placeholder="Search"]';
  private readonly table = 'table';
  private readonly tableRows = 'table tbody tr';
  private readonly resetButton = 'button:contains("Reset all")';
  private readonly actionDropdown = 'button:contains("Action")';
  private readonly paginationInfo = ':contains("/ page")';

  // Navigation
  visit() {
    cy.stepLog('Navigate directly to Contacts page');
    cy.visit('/app/customer-management/contacts');
    return this;
  }

  navigateFromDashboard() {
    cy.stepLog('Navigate to Dashboard');
    cy.visit('/app/dashboard');
    cy.wait(2000);
    cy.stepLog('Click sidebar menu: "Customers"');
    cy.contains('Customers').click({ force: true });
    cy.wait(1000);
    cy.stepLog('Click submenu: "Contacts"');
    cy.contains('Contacts').click({ force: true });
    cy.wait(2000);
    cy.stepLog('Verify Contacts page loaded');
    cy.url().should('include', '/customer-management/contacts');
    return this;
  }

  // Actions
  search(text: string) {
    cy.stepLog(`Type "${text}" into search input`);
    cy.get(this.searchInput).clear().type(text);
    cy.wait(1000); // Wait for debounce/filter
    return this;
  }

  clearSearch() {
    cy.stepLog('Clear search input');
    cy.get(this.searchInput).clear();
    cy.wait(500);
    return this;
  }

  clickResetAll() {
    cy.stepLog('Click "Reset all" button');
    cy.contains('button', 'Reset all').click();
    cy.wait(500);
    return this;
  }

  clickActionDropdown() {
    cy.stepLog('Click "Action" dropdown button');
    cy.contains('button', 'Action').click();
    return this;
  }

  selectFirstRow() {
    cy.stepLog('Select first row checkbox');
    cy.get(this.tableRows).first().find('input[type="checkbox"]').check();
    return this;
  }

  clickViewOnFirstRow() {
    cy.stepLog('Click "View" button on first row');
    cy.get(this.tableRows).first().contains('button', 'View').click();
    return this;
  }

  // Assertions
  shouldShowSearchInput() {
    cy.stepLog('Verify search input is visible and enabled');
    cy.get(this.searchInput).should('be.visible').and('be.enabled');
    return this;
  }

  shouldHaveSearchValue(value: string) {
    cy.stepLog(`Verify search input contains "${value}"`);
    cy.get(this.searchInput).should('have.value', value);
    return this;
  }

  shouldShowTable() {
    cy.stepLog('Verify contacts table is visible');
    cy.get(this.table).should('be.visible');
    return this;
  }

  shouldContainInTable(text: string) {
    cy.stepLog(`Verify table contains "${text}"`);
    cy.get('table tbody').should('contain', text);
    return this;
  }

  shouldHaveRowCount(count: number) {
    cy.stepLog(`Verify table has exactly ${count} rows`);
    cy.get(this.tableRows).should('have.length', count);
    return this;
  }

  shouldHaveRowCountGreaterThan(count: number) {
    cy.stepLog(`Verify table has more than ${count} rows`);
    cy.get(this.tableRows).should('have.length.gt', count);
    return this;
  }

  shouldShowNoData() {
    cy.stepLog('Verify "No data" message is displayed');
    cy.get('table tbody').then(($tbody) => {
      const rowCount = $tbody.find('tr').length;
      const text = $tbody.text();
      expect(rowCount === 0 || text.includes('No data') || text.includes('No results')).to.be.true;
    });
    return this;
  }

  shouldShowResetButton() {
    cy.stepLog('Verify "Reset all" button is visible');
    cy.contains('button', 'Reset all').should('be.visible');
    return this;
  }

  shouldShowPagination() {
    cy.stepLog('Verify pagination controls are visible');
    cy.contains('/ page').should('be.visible');
    return this;
  }

  shouldShowActionDropdown() {
    cy.stepLog('Verify "Action" dropdown is visible');
    cy.contains('button', 'Action').should('be.visible');
    return this;
  }

  // Helpers
  getRowCount(): Cypress.Chainable<number> {
    return cy.get(this.tableRows).then(($rows) => $rows.length);
  }

  getSearchInputValue(): Cypress.Chainable<string> {
    return cy
      .get(this.searchInput)
      .invoke('val')
      .then((val) => String(val || ''));
  }
}
