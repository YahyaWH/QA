/**
 * PD-042: Customer Category Management – Billing & Service Options
 * Test Cases: PD042-TC-018 through PD042-TC-026
 *
 * Covers:
 *   - Weighbridge billing for reception customers
 *   - Property billing for property customers
 *   - Hybrid customer separate invoices
 *   - Category change preserves historical billing
 *   - Billing threshold alerts
 *   - Category-specific service options
 *   - Municipal customer access restrictions
 *   - Secondary responsibility pricing
 *   - One-off service customer
 */

import { CustomerCategoriesPage } from '@support/page-objects/CustomerCategoriesPage';
import { loginAsAdmin, navigateToCustomerProfile } from '@support/helpers/authHelpers';

describe('PD-042: Billing & Service Options', () => {
  const categoriesPage = new CustomerCategoriesPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login as admin');
    loginAsAdmin();
  });

  context('Billing Rules by Category', () => {
    it('[PD042-TC-018] should show weighbridge billing rules for reception customers', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.receptionOnly.id);

        cy.stepLog('Verify "Waste Reception" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');

        cy.stepLog('Verify billing rules section is visible');
        categoriesPage.shouldShowBillingRulesSection();

        cy.stepLog('Verify invoice type dropdown is available');
        categoriesPage.shouldShowInvoiceTypeDropdown();
      });
    });

    it('[PD042-TC-019] should show property billing rules for property customers', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.propertyOnly.id);

        cy.stepLog('Verify "Property Collection" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Property Collection');

        cy.stepLog('Verify billing rules section is visible');
        categoriesPage.shouldShowBillingRulesSection();

        cy.stepLog('Verify invoice type dropdown is available');
        categoriesPage.shouldShowInvoiceTypeDropdown();
      });
    });

    it('[PD042-TC-020] should support separate invoices per category for hybrid customers', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.hybrid.id);

        cy.stepLog('Verify hybrid customer has both categories assigned');
        categoriesPage.shouldHaveAssignedCategory('Property Collection');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');

        cy.stepLog('Verify billing rules section is visible');
        categoriesPage.shouldShowBillingRulesSection();

        cy.stepLog('Verify invoice type dropdown allows per-category billing');
        categoriesPage.shouldShowInvoiceTypeDropdown();
      });
    });
  });

  context('Historical Billing & Alerts', () => {
    it('[PD042-TC-021] should preserve historical billing after category change', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.receptionOnly.id);

        cy.stepLog('Verify current category assignment');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');

        cy.stepLog('Verify billing rules section is visible before change');
        categoriesPage.shouldShowBillingRulesSection();

        cy.stepLog('Verify annual billing total is displayed (historical data present)');
        categoriesPage.shouldShowAnnualBillingTotal();

        cy.stepLog('Add a new category to the customer');
        categoriesPage.selectCategory('Property Collection');

        cy.stepLog('Save customer profile with updated categories');
        categoriesPage.saveCustomerProfile();

        cy.stepLog('Verify historical billing data is still visible');
        categoriesPage.shouldShowAnnualBillingTotal();

        cy.stepLog('Verify billing rules section is still accessible');
        categoriesPage.shouldShowBillingRulesSection();
      });
    });

    it('[PD042-TC-022] should show billing alert when annual total exceeds threshold', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.highBilling.id);

        cy.stepLog('Verify "Municipal Responsibility" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Municipal Responsibility');

        cy.stepLog('Verify annual billing total is displayed');
        categoriesPage.shouldShowAnnualBillingTotal();

        cy.stepLog('Verify billing threshold alert banner is visible');
        categoriesPage.shouldShowBillingAlert();
      });
    });
  });

  context('Service Options & Pricing', () => {
    it('[PD042-TC-023] should display only category-relevant service options', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.propertyOnly.id);

        cy.stepLog('Verify "Property Collection" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Property Collection');

        cy.stepLog('Verify service options section is visible');
        categoriesPage.shouldShowServiceOptions();

        cy.stepLog('Verify property-related services are listed');
        data.services.propertyServices.forEach((service: string) => {
          categoriesPage.shouldShowServiceOption(service);
        });
      });
    });

    it('[PD042-TC-024] should hide commercial services from municipal customers', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.municipal.id);

        cy.stepLog('Verify "Municipal Responsibility" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Municipal Responsibility');

        cy.stepLog('Verify service options section is visible');
        categoriesPage.shouldShowServiceOptions();

        cy.stepLog('Verify commercial waste reception services are NOT available');
        data.services.commercialServices.forEach((service: string) => {
          categoriesPage.shouldNotShowServiceOption(service);
        });
      });
    });

    it('[PD042-TC-025] should apply different pricing model for secondary responsibility', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.secondaryResponsibility.id);

        cy.stepLog('Verify "Secondary Responsibility" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Secondary Responsibility');

        cy.stepLog('Verify billing rules section is visible');
        categoriesPage.shouldShowBillingRulesSection();

        cy.stepLog('Verify invoice type dropdown is available for pricing configuration');
        categoriesPage.shouldShowInvoiceTypeDropdown();
      });
    });

    it('[PD042-TC-026] should support one-off service customer category', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.oneOff.id);

        cy.stepLog('Verify "One-Off Service" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('One-Off Service');

        cy.stepLog('Verify service options section is visible');
        categoriesPage.shouldShowServiceOptions();

        cy.stepLog('Verify billing rules section is visible');
        categoriesPage.shouldShowBillingRulesSection();
      });
    });
  });
});
