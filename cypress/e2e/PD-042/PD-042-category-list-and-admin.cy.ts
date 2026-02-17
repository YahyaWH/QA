/**
 * PD-042: Customer Category Management – Category List & Admin Access
 * Test Cases: PD042-TC-001 through PD042-TC-006
 *
 * Covers:
 *   - Category list page display
 *   - Available category types
 *   - Default categories (Property Collection, Waste Reception)
 *   - Name and Description columns
 *   - Admin-only access
 */

import { CustomerCategoriesPage } from '@support/page-objects/CustomerCategoriesPage';
import { setupCustomerCategoriesTest } from '@support/helpers/authHelpers';

describe('PD-042: Category List & Admin Access', () => {
  const categoriesPage = new CustomerCategoriesPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login and navigate to Customer Categories page');
    setupCustomerCategoriesTest();
  });

  context('Category List Page', () => {
    it('[PD042-TC-001] should display customer categories list page', () => {
      cy.stepLog('Verify the customer categories list table is visible');
      categoriesPage.shouldShowCategoryList();

      cy.stepLog('Verify the page URL is correct');
      cy.url().should('include', '/customer-management/customer-categories');
    });

    it('[PD042-TC-002] should list all available customer category types', () => {
      cy.stepLog('Verify the categories list has at least the default types');
      categoriesPage.shouldHaveCategoryCountGreaterThan(1);

      cy.stepLog('Verify "Property Collection" category is listed');
      categoriesPage.shouldContainCategory('Property Collection');

      cy.stepLog('Verify "Waste Reception" category is listed');
      categoriesPage.shouldContainCategory('Waste Reception');
    });

    it('[PD042-TC-005] should display Name and Description columns in category list', () => {
      cy.stepLog('Verify category list table shows Name and Description columns');
      categoriesPage.shouldShowCategoryColumns();
    });
  });

  context('Default Categories', () => {
    it('[PD042-TC-003] should have default "Property Collection" category type', () => {
      cy.stepLog('Verify "Property Collection" default category exists in the list');
      categoriesPage.shouldHaveDefaultCategoryPropertyCollection();
    });

    it('[PD042-TC-004] should have default "Waste Reception" category type', () => {
      cy.stepLog('Verify "Waste Reception" default category exists in the list');
      categoriesPage.shouldHaveDefaultCategoryWasteReception();
    });
  });

  context('Admin Access', () => {
    it('[PD042-TC-006] should show admin controls for category management', () => {
      cy.stepLog('Verify admin user can see "Add Category" button');
      categoriesPage.shouldShowAdminControls();

      cy.stepLog('Verify admin user can see the category list');
      categoriesPage.shouldShowCategoryList();
    });
  });
});
