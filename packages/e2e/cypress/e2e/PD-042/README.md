# PD-042: Customer Category Management Tests

## User Story

**As a** customer-service user,
**I want to** define and assign one or more customer categories to a single customer,
**so that** I can manage their information and invoicing rules effectively.

**As a** customer-service user,
**I want to** ensure that customer information is correctly transferred to the weighing system,
**so that** invoicing is generated accurately and only for relevant transactions.

---

## Structure

Tests are organized with **ONE test case per file** for maximum granularity, maintainability, and parallel execution.

```
PD-042/
├── PD-042-001.cy.ts  (TC-001: Category List Page Display)
├── PD-042-002.cy.ts  (TC-002: Available Category Types Listed)
├── PD-042-003.cy.ts  (TC-003: Default Category – Property Collection)
├── PD-042-004.cy.ts  (TC-004: Default Category – Waste Reception)
├── PD-042-005.cy.ts  (TC-005: Category List Displays Name and Description)
├── PD-042-006.cy.ts  (TC-006: Admin-Only Access to Category Management)
├── PD-042-007.cy.ts  (TC-007: Assign Single Category to Customer)
├── PD-042-008.cy.ts  (TC-008: Assign Multiple Categories to Customer)
├── PD-042-009.cy.ts  (TC-009: Customer Profile Displays Assigned Categories)
├── PD-042-010.cy.ts  (TC-010: Remove Category from Customer)
├── PD-042-011.cy.ts  (TC-011: Category Assignment Persists After Reload)
├── PD-042-012.cy.ts  (TC-012: Hybrid Customer Has Both Types)
├── PD-042-013.cy.ts  (TC-013: Reception Customer Data Transfers to Weighbridge)
├── PD-042-014.cy.ts  (TC-014: Property-Only Customer Excluded from Weighbridge)
├── PD-042-015.cy.ts  (TC-015: Customer Updates Sync Across Systems)
├── PD-042-016.cy.ts  (TC-016: Weighbridge Search by Business ID)
├── PD-042-017.cy.ts  (TC-017: Data Transfer Respects Category-Based Rules)
├── PD-042-018.cy.ts  (TC-018: Weighbridge Billing – Reception Customers Only)
├── PD-042-019.cy.ts  (TC-019: Property Billing – Property Customers Only)
├── PD-042-020.cy.ts  (TC-020: Hybrid Customer Separate Invoices)
├── PD-042-021.cy.ts  (TC-021: Category Change Preserves Historical Billing)
├── PD-042-022.cy.ts  (TC-022: Billing Alert for Threshold Exceeding)
├── PD-042-023.cy.ts  (TC-023: Category-Specific Service Options)
├── PD-042-024.cy.ts  (TC-024: Municipal Customer Cannot Access Commercial Services)
├── PD-042-025.cy.ts  (TC-025: Secondary Responsibility Pricing Model)
├── PD-042-026.cy.ts  (TC-026: One-Off Service Customer Terminates)
├── PD-042-027.cy.ts  (TC-027: Category Acts as Filter in Reports)
├── PD-042-028.cy.ts  (TC-028: Reports Segment by Statutory Classification)
├── PD-042-029.cy.ts  (TC-029: Reports Segment by Service Usage Type)
└── PD-042-030.cy.ts  (TC-030: Category Changes Do Not Disrupt Historical Data)
```

---

## Reusable Components

### **Page Object:** `CustomerCategoriesPage.ts`

```typescript
import { CustomerCategoriesPage } from '@support/page-objects/CustomerCategoriesPage';

const categoriesPage = new CustomerCategoriesPage();
categoriesPage.shouldShowCategoryList();
categoriesPage.shouldContainCategory('Property Collection');
```

### **Auth Helpers:** `authHelpers.ts`

```typescript
import {
  setupCustomerCategoriesTest,
  setupCustomerProfileTest,
  setupReportsTest,
} from '@support/helpers/authHelpers';

// Navigate to Customer Categories list page
beforeEach(() => {
  setupCustomerCategoriesTest();
});

// Navigate to a specific customer profile
beforeEach(() => {
  setupCustomerProfileTest('customer-id');
});

// Navigate to Reports page
beforeEach(() => {
  setupReportsTest();
});
```

### **Fixture Data:** `customerCategories.json`

```typescript
cy.fixture('customerCategories').then((data) => {
  const customer = data.customers.hybrid;
  setupCustomerProfileTest(customer.id);
});
```

---

## Running Tests

### **Run All PD-042 Tests:**

```bash
npx cypress run --spec "cypress/e2e/PD-042/*.cy.ts"
```

### **Run Specific Test File:**

```bash
npx cypress run --spec "cypress/e2e/PD-042/PD-042-001.cy.ts"
```

### **Run Range of Tests:**

```bash
# Run UI component tests (001-006)
npx cypress run --spec "cypress/e2e/PD-042/PD-042-00[1-6].cy.ts"

# Run assignment tests (007-012)
npx cypress run --spec "cypress/e2e/PD-042/PD-042-00[7-9].cy.ts,cypress/e2e/PD-042/PD-042-01[0-2].cy.ts"

# Run data transfer tests (013-017)
npx cypress run --spec "cypress/e2e/PD-042/PD-042-01[3-7].cy.ts"
```

### **Run in Headed Mode:**

```bash
npx cypress run --headed --browser chrome --spec "cypress/e2e/PD-042/PD-042-008.cy.ts"
```

---

## Test Coverage

| File Range       | Test IDs             | Count  | Focus Category                   |
| ---------------- | -------------------- | ------ | -------------------------------- |
| PD-042-001 – 006 | TC-001 to TC-006     | 6      | UI Components & Category List    |
| PD-042-007 – 012 | TC-007 to TC-012     | 6      | Category Assignment to Customers |
| PD-042-013 – 017 | TC-013 to TC-017     | 5      | Data Transfer & External Systems |
| PD-042-018 – 022 | TC-018 to TC-022     | 5      | Billing Management               |
| PD-042-023 – 026 | TC-023 to TC-026     | 4      | Product Offering & Visibility    |
| PD-042-027 – 029 | TC-027 to TC-029     | 3      | Reporting & Compliance           |
| PD-042-030       | TC-030               | 1      | Regression / Data Integrity      |
| **TOTAL**        | **TC-001 to TC-030** | **30** | **Complete Coverage**            |

---

## Acceptance Criteria Traceability

| Acceptance Criteria                                 | Test Cases             |
| --------------------------------------------------- | ---------------------- |
| Category list maintained                            | TC-001 to TC-006       |
| Category-specific business rules defined            | TC-017 to TC-026       |
| Multiple categories per customer                    | TC-007, TC-008, TC-012 |
| Default types: Property Collection, Waste Reception | TC-003, TC-004         |
| Data transfer to weighbridge controlled by category | TC-013 to TC-017       |
| Invoicing controlled by category                    | TC-018 to TC-022       |
| Category changes preserve historical data           | TC-021, TC-030         |
| Categories act as report filters                    | TC-027 to TC-029       |
| Regulatory compliance support                       | TC-024, TC-025, TC-028 |
| Role-based access (admin only)                      | TC-006                 |

---

## Benefits of This Structure

- **Modularity** – Each file is independent and focused
- **Reusability** – Shared page object and helpers reduce code duplication
- **Maintainability** – Easy to find and update specific tests
- **Parallel Execution** – Tests can run simultaneously
- **Faster Debugging** – Run only the failing test file
- **Clear Organization** – File names indicate test purpose
- **Traceability** – Each test maps to a specific acceptance criterion

---

## Adding New Tests

1. Create new file: `PD-042-031.cy.ts` (next sequential number)
2. Import helpers:
   ```typescript
   import { CustomerCategoriesPage } from '@support/page-objects/CustomerCategoriesPage';
   import { setupCustomerCategoriesTest } from '@support/helpers/authHelpers';
   ```
3. Follow the naming pattern:
   - **File name:** `PD-042-###.cy.ts` (e.g., `PD-042-031.cy.ts`)
   - **Test ID:** `[PD042-TC-###]` (e.g., `[PD042-TC-031]`)
   - **Describe:** `PD-042-###: Clear Test Description`
4. Update this README with new test count

---

## Related Files

- **Page Object:** `cypress/support/page-objects/CustomerCategoriesPage.ts`
- **Auth Helpers:** `cypress/support/helpers/authHelpers.ts`
- **Fixture Data:** `cypress/fixtures/customerCategories.json`

---

**Last Updated:** February 17, 2026
**Test Count:** 30 tests across 30 files (1 test per file)
**Naming Convention:** PD-042-###.cy.ts (zero-padded, 3-digit test IDs)
**Status:** Ready for execution
