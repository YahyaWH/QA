/**
 * PD-042: Customer Category Management – Data Transfer & Weighbridge
 * Test Cases: PD042-TC-013 through PD042-TC-017
 *
 * Covers:
 *   - Reception customer data transfers to weighbridge
 *   - Property-only customer excluded from weighbridge
 *   - Customer updates sync across systems
 *   - Weighbridge search by Business ID
 *   - Data transfer respects category-based rules
 */

import { CustomerCategoriesPage } from '@support/page-objects/CustomerCategoriesPage';
import {
  loginAsAdmin,
  navigateToCustomerProfile,
  setupCustomerProfileTest,
} from '@support/helpers/authHelpers';

describe('PD-042: Data Transfer & Weighbridge', () => {
  const categoriesPage = new CustomerCategoriesPage();

  beforeEach(() => {
    cy.stepLog('Setup: Login as admin');
    loginAsAdmin();
  });

  context('Weighbridge Transfer Rules', () => {
    it('[PD042-TC-013] should enable weighbridge data transfer for reception customers', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.receptionOnly.id);

        cy.stepLog('Verify "Waste Reception" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');

        cy.stepLog('Verify weighbridge data transfer toggle is enabled');
        categoriesPage.shouldShowWeighbridgeTransferEnabled();
      });
    });

    it('[PD042-TC-014] should disable weighbridge data transfer for property-only customers', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.propertyOnly.id);

        cy.stepLog('Verify "Property Collection" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Property Collection');

        cy.stepLog('Verify weighbridge data transfer toggle is disabled');
        categoriesPage.shouldShowWeighbridgeTransferDisabled();
      });
    });

    it('[PD042-TC-017] should enforce category-based data transfer rules', () => {
      cy.fixture('customerCategories').then((data) => {
        cy.stepLog('Check reception customer: weighbridge transfer should be ENABLED');
        setupCustomerProfileTest(data.customers.receptionOnly.id);
        categoriesPage.shouldShowWeighbridgeTransferEnabled();

        cy.stepLog('Check property-only customer: weighbridge transfer should be DISABLED');
        setupCustomerProfileTest(data.customers.propertyOnly.id);
        categoriesPage.shouldShowWeighbridgeTransferDisabled();
      });
    });
  });

  context('Sync & Business ID', () => {
    it('[PD042-TC-015] should show sync status for reception customer data', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.receptionOnly.id);

        cy.stepLog('Verify "Waste Reception" category is assigned');
        categoriesPage.shouldHaveAssignedCategory('Waste Reception');

        cy.stepLog('Verify Business ID field is visible on the profile');
        categoriesPage.shouldShowBusinessIdField();

        cy.stepLog('Verify sync status indicator shows data is synced');
        categoriesPage.shouldShowSyncStatusActive();
      });
    });

    it('[PD042-TC-016] should display Business ID for weighbridge search', () => {
      cy.fixture('customerCategories').then((data) => {
        navigateToCustomerProfile(data.customers.receptionOnly.id);

        cy.stepLog('Verify Business ID field is visible');
        categoriesPage.shouldShowBusinessIdField();

        cy.stepLog('Verify weighbridge data transfer is enabled for this customer');
        categoriesPage.shouldShowWeighbridgeTransferEnabled();

        cy.stepLog('Verify customer data is synced to external system');
        categoriesPage.shouldShowSyncStatusActive();
      });
    });
  });
});
