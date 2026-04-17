/**
 * Page Object Model for Customer Categories Management
 * URL: /app/customer-management/customer-categories
 * Navigation: Customers (sidebar) -> Customer Categories (submenu)
 *
 * Covers customer category CRUD, assignment to customers,
 * data transfer rules, billing logic, and reporting filters.
 */

export class CustomerCategoriesPage {
  // ── Selectors: Category List Page ──────────────────────────────
  private readonly categoryListTable = 'table';
  private readonly categoryListRows = 'table tbody tr';
  private readonly addCategoryButton = 'button:contains("Add Category")';
  private readonly categoryNameColumn = 'table thead th:contains("Name")';
  private readonly categoryDescriptionColumn = 'table thead th:contains("Description")';
  private readonly searchInput = 'input[placeholder="Search"]';

  // ── Selectors: Category Form / Modal ───────────────────────────
  private readonly categoryNameInput = '[data-testid="category-name"]';
  private readonly categoryDescriptionInput = '[data-testid="category-description"]';
  private readonly saveCategoryButton = 'button:contains("Save")';
  private readonly cancelButton = 'button:contains("Cancel")';
  private readonly deleteButton = 'button:contains("Delete")';
  private readonly confirmDeleteButton = 'button:contains("Confirm")';

  // ── Selectors: Customer Profile – Category Assignment ──────────
  private readonly categoryMultiSelect = '[data-testid="customer-category-select"]';
  private readonly categoryChip = '[data-testid="category-chip"]';
  private readonly categoryDropdownOption = '[data-testid="category-option"]';
  private readonly removeCategoryIcon = '[data-testid="remove-category"]';
  private readonly customerProfileSaveButton = 'button:contains("Save")';

  // ── Selectors: Data Transfer & Weighbridge ─────────────────────
  private readonly weighbridgeTransferToggle = '[data-testid="weighbridge-transfer"]';
  private readonly syncStatusIndicator = '[data-testid="sync-status"]';
  private readonly businessIdField = '[data-testid="business-id"]';

  // ── Selectors: Billing ─────────────────────────────────────────
  private readonly billingRulesSection = '[data-testid="billing-rules"]';
  private readonly invoiceTypeDropdown = '[data-testid="invoice-type"]';
  private readonly billingAlertBanner = '[data-testid="billing-alert"]';
  private readonly annualBillingTotal = '[data-testid="annual-billing-total"]';

  // ── Selectors: Product Offering ────────────────────────────────
  private readonly serviceOptionsSection = '[data-testid="service-options"]';
  private readonly serviceOptionItem = '[data-testid="service-option"]';

  // ── Selectors: Reporting & Filters ─────────────────────────────
  private readonly reportCategoryFilter = '[data-testid="report-category-filter"]';
  private readonly reportTable = '[data-testid="report-table"]';
  private readonly reportTableRows = '[data-testid="report-table"] tbody tr';

  // ── Selectors: Access Control ──────────────────────────────────
  private readonly adminBadge = '[data-testid="admin-badge"]';
  private readonly accessDeniedMessage = ':contains("Access Denied")';

  // ═══════════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════════

  visit() {
    cy.stepLog('Navigate directly to Customer Categories page');
    cy.visit('/app/customer-management/customer-categories');
    return this;
  }

  visitCustomerProfile(customerId: string) {
    cy.stepLog(`Navigate to customer profile: ${customerId}`);
    cy.visit(`/app/customer-management/contacts/${customerId}`);
    return this;
  }

  visitBillingSection(customerId: string) {
    cy.stepLog(`Navigate to billing section for customer: ${customerId}`);
    cy.visit(`/app/customer-management/contacts/${customerId}/billing`);
    return this;
  }

  visitReports() {
    cy.stepLog('Navigate to Reports page');
    cy.visit('/app/reports');
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Actions: Category List
  // ═══════════════════════════════════════════════════════════════

  clickAddCategory() {
    cy.stepLog('Click "Add Category" button');
    cy.contains('button', 'Add Category').click();
    return this;
  }

  searchCategories(text: string) {
    cy.stepLog(`Search categories for "${text}"`);
    cy.get(this.searchInput).clear();
    cy.get(this.searchInput).type(text);
    cy.get(this.categoryListTable).should('be.visible');
    return this;
  }

  clickCategoryRow(categoryName: string) {
    cy.stepLog(`Click category row: "${categoryName}"`);
    cy.contains(this.categoryListRows, categoryName).click();
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Actions: Category Form
  // ═══════════════════════════════════════════════════════════════

  fillCategoryName(name: string) {
    cy.stepLog(`Enter category name: "${name}"`);
    cy.get(this.categoryNameInput).clear();
    cy.get(this.categoryNameInput).type(name);
    return this;
  }

  fillCategoryDescription(description: string) {
    cy.stepLog(`Enter category description: "${description}"`);
    cy.get(this.categoryDescriptionInput).clear();
    cy.get(this.categoryDescriptionInput).type(description);
    return this;
  }

  saveCategory() {
    cy.stepLog('Click "Save" to save category');
    cy.contains('button', 'Save').click();
    cy.contains('successfully').should('be.visible');
    return this;
  }

  cancelCategoryForm() {
    cy.stepLog('Click "Cancel" to discard changes');
    cy.contains('button', 'Cancel').click();
    return this;
  }

  deleteCategory() {
    cy.stepLog('Click "Delete" to remove category');
    cy.contains('button', 'Delete').click();
    return this;
  }

  confirmDelete() {
    cy.stepLog('Confirm category deletion');
    cy.contains('button', 'Confirm').click();
    cy.contains('successfully').should('be.visible');
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Actions: Category Assignment on Customer Profile
  // ═══════════════════════════════════════════════════════════════

  openCategorySelector() {
    cy.stepLog('Open customer category multi-select dropdown');
    cy.get(this.categoryMultiSelect).click();
    return this;
  }

  selectCategory(categoryName: string) {
    cy.stepLog(`Select category: "${categoryName}"`);
    cy.get(this.categoryMultiSelect).click();
    cy.contains(this.categoryDropdownOption, categoryName).click();
    return this;
  }

  removeCategory(categoryName: string) {
    cy.stepLog(`Remove category: "${categoryName}"`);
    cy.contains(this.categoryChip, categoryName).find(this.removeCategoryIcon).click();
    return this;
  }

  saveCustomerProfile() {
    cy.stepLog('Save customer profile changes');
    cy.contains('button', 'Save').click();
    cy.contains('successfully').should('be.visible');
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Actions: Reporting Filters
  // ═══════════════════════════════════════════════════════════════

  selectReportCategoryFilter(categoryName: string) {
    cy.stepLog(`Filter report by category: "${categoryName}"`);
    cy.get(this.reportCategoryFilter).click();
    cy.contains(categoryName).click();
    cy.get(this.reportTable).should('be.visible');
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Assertions: Category List
  // ═══════════════════════════════════════════════════════════════

  shouldShowCategoryList() {
    cy.stepLog('Verify customer categories list table is visible');
    cy.get(this.categoryListTable).should('be.visible');
    return this;
  }

  shouldShowAddCategoryButton() {
    cy.stepLog('Verify "Add Category" button is visible');
    cy.contains('button', 'Add Category').should('be.visible');
    return this;
  }

  shouldContainCategory(categoryName: string) {
    cy.stepLog(`Verify category "${categoryName}" exists in the list`);
    cy.get(this.categoryListTable).should('contain', categoryName);
    return this;
  }

  shouldNotContainCategory(categoryName: string) {
    cy.stepLog(`Verify category "${categoryName}" does NOT exist in the list`);
    cy.get(this.categoryListTable).should('not.contain', categoryName);
    return this;
  }

  shouldHaveCategoryCount(count: number) {
    cy.stepLog(`Verify exactly ${count} categories are listed`);
    cy.get(this.categoryListRows).should('have.length', count);
    return this;
  }

  shouldHaveCategoryCountGreaterThan(count: number) {
    cy.stepLog(`Verify more than ${count} categories are listed`);
    cy.get(this.categoryListRows).should('have.length.gt', count);
    return this;
  }

  shouldShowCategoryColumns() {
    cy.stepLog('Verify category list shows Name and Description columns');
    cy.get('table thead').should('contain', 'Name');
    cy.get('table thead').should('contain', 'Description');
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Assertions: Default Types
  // ═══════════════════════════════════════════════════════════════

  shouldHaveDefaultCategoryPropertyCollection() {
    cy.stepLog('Verify default category "Property Collection" exists');
    cy.get(this.categoryListTable).should('contain', 'Property Collection');
    return this;
  }

  shouldHaveDefaultCategoryWasteReception() {
    cy.stepLog('Verify default category "Waste Reception" exists');
    cy.get(this.categoryListTable).should('contain', 'Waste Reception');
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Assertions: Category Assignment on Customer Profile
  // ═══════════════════════════════════════════════════════════════

  shouldShowCategorySelector() {
    cy.stepLog('Verify customer category multi-select is visible');
    cy.get(this.categoryMultiSelect).should('be.visible');
    return this;
  }

  shouldHaveAssignedCategory(categoryName: string) {
    cy.stepLog(`Verify category "${categoryName}" is assigned to customer`);
    cy.get(this.categoryChip).should('contain', categoryName);
    return this;
  }

  shouldNotHaveAssignedCategory(categoryName: string) {
    cy.stepLog(`Verify category "${categoryName}" is NOT assigned to customer`);
    cy.get(this.categoryChip).should('not.contain', categoryName);
    return this;
  }

  shouldHaveMultipleCategories(count: number) {
    cy.stepLog(`Verify customer has exactly ${count} categories assigned`);
    cy.get(this.categoryChip).should('have.length', count);
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Assertions: Data Transfer / Weighbridge
  // ═══════════════════════════════════════════════════════════════

  shouldShowWeighbridgeTransferEnabled() {
    cy.stepLog('Verify weighbridge data transfer is enabled');
    cy.get(this.weighbridgeTransferToggle).should('be.checked');
    return this;
  }

  shouldShowWeighbridgeTransferDisabled() {
    cy.stepLog('Verify weighbridge data transfer is disabled');
    cy.get(this.weighbridgeTransferToggle).should('not.be.checked');
    return this;
  }

  shouldShowSyncStatusActive() {
    cy.stepLog('Verify external system sync status is active');
    cy.get(this.syncStatusIndicator).should('contain', 'Synced');
    return this;
  }

  shouldShowBusinessIdField() {
    cy.stepLog('Verify Business ID field is visible');
    cy.get(this.businessIdField).should('be.visible');
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Assertions: Billing
  // ═══════════════════════════════════════════════════════════════

  shouldShowBillingRulesSection() {
    cy.stepLog('Verify billing rules section is visible');
    cy.get(this.billingRulesSection).should('be.visible');
    return this;
  }

  shouldShowBillingAlert() {
    cy.stepLog('Verify billing threshold alert banner is visible');
    cy.get(this.billingAlertBanner).should('be.visible');
    return this;
  }

  shouldShowAnnualBillingTotal() {
    cy.stepLog('Verify annual billing total is displayed');
    cy.get(this.annualBillingTotal).should('be.visible');
    return this;
  }

  shouldShowInvoiceTypeDropdown() {
    cy.stepLog('Verify invoice type dropdown is visible');
    cy.get(this.invoiceTypeDropdown).should('be.visible');
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Assertions: Product Offering
  // ═══════════════════════════════════════════════════════════════

  shouldShowServiceOptions() {
    cy.stepLog('Verify service options section is visible');
    cy.get(this.serviceOptionsSection).should('be.visible');
    return this;
  }

  shouldShowServiceOption(serviceName: string) {
    cy.stepLog(`Verify service option "${serviceName}" is visible`);
    cy.get(this.serviceOptionsSection).should('contain', serviceName);
    return this;
  }

  shouldNotShowServiceOption(serviceName: string) {
    cy.stepLog(`Verify service option "${serviceName}" is NOT visible`);
    cy.get(this.serviceOptionsSection).should('not.contain', serviceName);
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Assertions: Reporting
  // ═══════════════════════════════════════════════════════════════

  shouldShowReportCategoryFilter() {
    cy.stepLog('Verify report category filter is visible');
    cy.get(this.reportCategoryFilter).should('be.visible');
    return this;
  }

  shouldShowReportTable() {
    cy.stepLog('Verify report table is visible');
    cy.get(this.reportTable).should('be.visible');
    return this;
  }

  shouldShowReportRows() {
    cy.stepLog('Verify report table has data rows');
    cy.get(this.reportTableRows).should('have.length.gt', 0);
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Assertions: Access Control
  // ═══════════════════════════════════════════════════════════════

  shouldShowAccessDenied() {
    cy.stepLog('Verify access denied message is displayed');
    cy.contains('Access Denied').should('be.visible');
    return this;
  }

  shouldShowAdminControls() {
    cy.stepLog('Verify admin-only controls are visible');
    cy.contains('button', 'Add Category').should('be.visible');
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Assertions: Success / Error Messages
  // ═══════════════════════════════════════════════════════════════

  shouldShowSuccessMessage() {
    cy.stepLog('Verify success notification is displayed');
    cy.contains('successfully').should('be.visible');
    return this;
  }

  shouldShowErrorMessage(message?: string) {
    cy.stepLog('Verify error notification is displayed');
    if (message) {
      cy.contains(message).should('be.visible');
    } else {
      cy.get('[role="alert"], .notification-error, .toast-error').should('be.visible');
    }
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════

  getCategoryCount(): Cypress.Chainable<number> {
    return cy.get(this.categoryListRows).then(($rows) => $rows.length);
  }

  getAssignedCategoryCount(): Cypress.Chainable<number> {
    return cy.get(this.categoryChip).then(($chips) => $chips.length);
  }
}
