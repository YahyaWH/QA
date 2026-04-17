/**
 * PD-042: Customer Category Management – Category Assignment
 * Test Cases: PD042-TC-007 through PD042-TC-012
 *
 * Covers:
 *   - Assign single category to customer
 *   - Assign multiple categories to customer
 *   - Customer profile displays assigned categories
 *   - Remove category from customer
 *   - Category assignment persists after reload
 *   - Hybrid customer with both collection and reception types
 */

import { CustomerCategoriesPage } from '@support/page-objects/CustomerCategoriesPage';
import { loginAsAdmin, navigateToCustomerProfile } from '@support/helpers/authHelpers';

describe('PD-042: Category Assignment', () => {
  const categoriesPage = new CustomerCategoriesPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login as admin');
    loginAsAdmin();
  });

  context('Assign Categories', () => {
    it('[PD042-TC-007] should assign a single category to a customer', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.propertyOnly.id);

        cy.stepLog('Verify customer category selector is visible');
        categoriesPage.shouldShowCategorySelector();

        cy.stepLog('Select "Property Collection" category');
        categoriesPage.selectCategory('Property Collection');

        cy.stepLog('Save customer profile');
        categoriesPage.saveCustomerProfile();

        cy.stepLog('Verify "Property Collection" is assigned to the customer');
        categoriesPage.shouldHaveAssignedCategory('Property Collection');
      });
    });

    it('[PD042-TC-008] should assign multiple categories to a single customer', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.hybrid.id);

        cy.stepLog('Verify customer category selector is visible');
        categoriesPage.shouldShowCategorySelector();

        cy.stepLog('Select "Property Collection" category');
        categoriesPage.selectCategory('Property Collection');

        cy.stepLog('Select "Waste Reception" category');
        categoriesPage.selectCategory('Waste Reception');

        cy.stepLog('Save customer profile');
        categoriesPage.saveCustomerProfile();

        cy.stepLog('Verify both categories are assigned');
        categoriesPage.shouldHaveAssignedCategory('Property Collection');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');
        categoriesPage.shouldHaveMultipleCategories(2);
      });
    });
  });

  context('View & Remove Categories', () => {
    it('[PD042-TC-009] should display assigned categories on customer profile', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.receptionOnly.id);

        cy.stepLog('Verify customer category selector is visible');
        categoriesPage.shouldShowCategorySelector();

        cy.stepLog('Verify the assigned category chip is displayed');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');
      });
    });

    it('[PD042-TC-010] should remove a category from a customer', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.hybrid.id);

        cy.stepLog('Verify hybrid customer has multiple categories assigned');
        categoriesPage.shouldHaveAssignedCategory('Property Collection');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');

        cy.stepLog('Remove "Property Collection" category');
        categoriesPage.removeCategory('Property Collection');

        cy.stepLog('Save customer profile');
        categoriesPage.saveCustomerProfile();

        cy.stepLog('Verify "Property Collection" is no longer assigned');
        categoriesPage.shouldNotHaveAssignedCategory('Property Collection');

        cy.stepLog('Verify "Waste Reception" remains assigned');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');
      });
    });
  });

  context('Persistence & Hybrid', () => {
    it('[PD042-TC-011] should persist category assignment after page reload', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.receptionOnly.id);

        cy.stepLog('Verify "Waste Reception" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');

        cy.stepLog('Reload the page');
        cy.reload();

        cy.stepLog('Verify category assignment persists after reload');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');
      });
    });

    it('[PD042-TC-012] should support hybrid customer with both collection and reception types', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.hybrid.id);

        cy.stepLog('Verify "Property Collection" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Property Collection');

        cy.stepLog('Verify "Waste Reception" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');

        cy.stepLog('Verify customer has exactly 2 categories');
        categoriesPage.shouldHaveMultipleCategories(2);
      });
    });
  });
});
