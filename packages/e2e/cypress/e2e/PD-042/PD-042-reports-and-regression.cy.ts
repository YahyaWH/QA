/**
 * PD-042: Customer Category Management – Reports & Regression
 * Test Cases: PD042-TC-027 through PD042-TC-030
 *
 * Covers:
 *   - Category acts as filter in reports
 *   - Reports segment by statutory classification
 *   - Reports segment by service usage type
 *   - Category changes do not disrupt historical data (regression)
 */

import { CustomerCategoriesPage } from '@support/page-objects/CustomerCategoriesPage';
import {
  loginAsAdmin,
  navigateToCustomerProfile,
  setupReportsTest,
} from '@support/helpers/authHelpers';

describe('PD-042: Reports & Regression', () => {
  const categoriesPage = new CustomerCategoriesPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login as admin');
    loginAsAdmin();
  });

  context('Report Filters', () => {
    beforeEach(() => {
      cy.stepLog('Navigate to Reports page');
      cy.visit('/app/reports');
      cy.url().should('include', '/reports');
    });

    it('[PD042-TC-027] should show category filter on reports page', () => {
      cy.stepLog('Verify report category filter is visible');
      categoriesPage.shouldShowReportCategoryFilter();

      cy.stepLog('Verify report table is visible');
      categoriesPage.shouldShowReportTable();
    });

    it('[PD042-TC-028] should filter reports by statutory classification', () => {
      cy.stepLog('Verify report category filter is available');
      categoriesPage.shouldShowReportCategoryFilter();

      cy.stepLog('Filter report by "Municipal Responsibility"');
      categoriesPage.selectReportCategoryFilter('Municipal Responsibility');

      cy.stepLog('Verify report table shows filtered results');
      categoriesPage.shouldShowReportRows();
    });

    it('[PD042-TC-029] should filter reports by service usage type', () => {
      cy.stepLog('Verify report category filter is available');
      categoriesPage.shouldShowReportCategoryFilter();

      cy.stepLog('Filter report by "Waste Reception" category');
      categoriesPage.selectReportCategoryFilter('Waste Reception');

      cy.stepLog('Verify report table shows filtered results');
      categoriesPage.shouldShowReportRows();
    });
  });

  context('Regression: Historical Data Integrity', () => {
    it('[PD042-TC-030] should not disrupt historical data when categories change', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.hybrid.id);

        cy.stepLog('Verify hybrid customer has both categories assigned');
        categoriesPage.shouldHaveAssignedCategory('Property Collection');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');

        cy.stepLog('Verify billing rules section shows historical data');
        categoriesPage.shouldShowBillingRulesSection();
        categoriesPage.shouldShowAnnualBillingTotal();

        cy.stepLog('Remove "Property Collection" category');
        categoriesPage.removeCategory('Property Collection');

        cy.stepLog('Save customer profile with category change');
        categoriesPage.saveCustomerProfile();

        cy.stepLog('Verify historical billing data is still intact');
        categoriesPage.shouldShowAnnualBillingTotal();

        cy.stepLog('Verify billing rules section remains accessible');
        categoriesPage.shouldShowBillingRulesSection();

        cy.stepLog('Restore original categories for test cleanup');
        categoriesPage.selectCategory('Property Collection');
        categoriesPage.saveCustomerProfile();

        cy.stepLog('Verify both categories are restored');
        categoriesPage.shouldHaveAssignedCategory('Property Collection');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');
      });
    });
  });
});
