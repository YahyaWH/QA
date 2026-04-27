/**
 * Page Object Model for Dashboard Page
 */
export class DashboardPage {
  // Selectors
  private readonly pageTitle = '[data-testid="dashboard-title"]';
  private readonly balanceCard = '[data-testid="balance-card"]';
  private readonly transactionsList = '[data-testid="transactions-list"]';
  private readonly addTransactionBtn = '[data-testid="add-transaction-btn"]';

  // Actions
  visit() {
    cy.stepLog('Navigate to Dashboard');
    cy.visit('/dashboard');
    return this;
  }

  clickAddTransaction() {
    cy.stepLog('Click "Add Transaction" button');
    cy.get(this.addTransactionBtn).click();
    return this;
  }

  // Assertions
  shouldBeVisible() {
    cy.stepLog('Verify Dashboard page is visible');
    cy.get(this.pageTitle).should('be.visible');
    return this;
  }

  shouldShowBalance(amount: string) {
    cy.stepLog(`Verify balance shows "${amount}"`);
    cy.get(this.balanceCard).should('contain', amount);
    return this;
  }

  shouldShowTransactions() {
    cy.stepLog('Verify transactions list is visible');
    cy.get(this.transactionsList).should('be.visible');
    return this;
  }
}
