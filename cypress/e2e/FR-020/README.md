# FR-020: Customer Search Feature Tests

## 📁 **Structure**

Tests are organized with **ONE test case per file** for maximum granularity, maintainability, and parallel execution.

```
FR-020/
├── FR-020-001.cy.ts  (TC-001: Search Input Display)
├── FR-020-002.cy.ts  (TC-002: Search Icon Display)
├── FR-020-003.cy.ts  (TC-003: Filter Button Display)
├── FR-020-004.cy.ts  (TC-004: Search Input Typing)
├── FR-020-005.cy.ts  (TC-005: Search Table Filtering)
├── FR-020-006.cy.ts  (TC-006: Case-Insensitive Search)
├── FR-020-007.cy.ts  (TC-007: Partial Match Search)
├── FR-020-008.cy.ts  (TC-008: Clear Search Functionality)
├── FR-020-009.cy.ts  (TC-009: Search by Customer Name)
├── FR-020-010.cy.ts  (TC-010: Search by Phone Number)
├── FR-020-011.cy.ts  (TC-011: No Results Display)
├── FR-020-012.cy.ts  (TC-012: Reset Button Presence)
├── FR-020-013.cy.ts  (TC-013: Reset Button Functionality)
├── FR-020-014.cy.ts  (TC-014: Table Data Display)
├── FR-020-015.cy.ts  (TC-015: Actionable Rows)
├── FR-020-016.cy.ts  (TC-016: Pagination Support)
├── FR-020-017.cy.ts  (TC-017: Row Selection Checkboxes)
├── FR-020-018.cy.ts  (TC-018: Filter Button Presence)
├── FR-020-019.cy.ts  (TC-019: Search and Filter Integration)
├── FR-020-020.cy.ts  (TC-020: Action Dropdown Presence)
├── FR-020-021.cy.ts  (TC-021: Action Dropdown Functionality)
├── FR-020-022.cy.ts  (TC-022: Search Performance)
└── FR-020-023.cy.ts  (TC-023: Page Navigation Regression)
```

---

## 🔧 **Reusable Components**

### **Page Object:** `ContactsPage.ts`

```typescript
import { ContactsPage } from '@support/page-objects/ContactsPage';

const contactsPage = new ContactsPage();
contactsPage.search('test').shouldContainInTable('test');
```

### **Auth Helpers:** `authHelpers.ts`

```typescript
import { setupContactsTest } from '@support/helpers/authHelpers';

beforeEach(() => {
  setupContactsTest(); // Logs in and navigates to Contacts page
});
```

---

## 🚀 **Running Tests**

### **Run All FR-020 Tests:**

```bash
npx cypress run --spec "cypress/e2e/FR-020/*.cy.ts"
```

### **Run Specific Test File:**

```bash
npx cypress run --spec "cypress/e2e/FR-020/FR-020-001.cy.ts"
```

### **Run Range of Tests:**

```bash
# Run tests 001-010
npx cypress run --spec "cypress/e2e/FR-020/FR-020-00[1-9].cy.ts,cypress/e2e/FR-020/FR-020-010.cy.ts"
```

### **Run in Headed Mode:**

```bash
npx cypress run --headed --browser chrome --spec "cypress/e2e/FR-020/FR-020-005.cy.ts"
```

### **Run Headless with Video:**

```bash
npx cypress run --spec "cypress/e2e/FR-020/*.cy.ts"
```

---

## 📊 **Test Coverage**

| File Range     | Test IDs             | Count  | Focus Category        |
| -------------- | -------------------- | ------ | --------------------- |
| FR-020-001-003 | TC-001 to TC-003     | 3      | UI Components         |
| FR-020-004-008 | TC-004 to TC-008     | 5      | Basic Search          |
| FR-020-009-011 | TC-009 to TC-011     | 3      | Search Data Types     |
| FR-020-012-013 | TC-012 to TC-013     | 2      | Reset Functionality   |
| FR-020-014-017 | TC-014 to TC-017     | 4      | Table Interactions    |
| FR-020-018-019 | TC-018 to TC-019     | 2      | Filter Integration    |
| FR-020-020-021 | TC-020 to TC-021     | 2      | Action Dropdown       |
| FR-020-022     | TC-022               | 1      | Performance           |
| FR-020-023     | TC-023               | 1      | Regression            |
| **TOTAL**      | **TC-001 to TC-023** | **23** | **Complete Coverage** |

---

## 💡 **Benefits of This Structure**

✅ **Modularity** - Each file is independent and focused  
✅ **Reusability** - Shared helpers reduce code duplication  
✅ **Maintainability** - Easy to find and update specific tests  
✅ **Parallel Execution** - Tests can run simultaneously  
✅ **Faster Debugging** - Run only the failing test file  
✅ **Clear Organization** - File names indicate test purpose

---

## 📝 **Example Usage**

### **Using ContactsPage:**

```typescript
import { ContactsPage } from '@support/page-objects/ContactsPage';
import { setupContactsTest } from '@support/helpers/authHelpers';

describe('My Test', () => {
  const contactsPage = new ContactsPage();

  beforeEach(() => {
    setupContactsTest(); // Login + navigate to Contacts
  });

  it('should search and verify', () => {
    contactsPage
      .search('WasteHero')
      .shouldContainInTable('WasteHero')
      .shouldHaveRowCountGreaterThan(0);
  });
});
```

### **Using Auth Helpers:**

```typescript
import { loginAsAdmin, navigateToContacts } from '@support/helpers/authHelpers';

beforeEach(() => {
  loginAsAdmin();
  navigateToContacts();
});
```

---

## 🔄 **Adding New Tests**

1. Create new file: `FR-020-024.cy.ts` (next sequential number)
2. Import helpers:
   ```typescript
   import { ContactsPage } from '@support/page-objects/ContactsPage';
   import { setupContactsTest } from '@support/helpers/authHelpers';
   ```
3. Follow the naming pattern:
   - **File name:** `FR-020-###.cy.ts` (e.g., `FR-020-024.cy.ts`)
   - **Test ID:** `[FR020-TC-###]` (e.g., `[FR020-TC-024]`)
   - **Description:** `FR-020-###: Clear Test Description`
4. Update this README with new test count

---

## 📚 **Related Files**

- **Page Object:** `cypress/support/page-objects/ContactsPage.ts`
- **Auth Helpers:** `cypress/support/helpers/authHelpers.ts`
- **Test IDs:** `FR-020-TEST-IDS.md` (root folder)
- **Test Results:** `FR-020-TEST-RESULTS.md` (root folder)

---

**Last Updated:** February 12, 2026  
**Test Count:** 23 tests across 23 files (1 test per file)  
**Naming Convention:** FR-020-###.cy.ts (zero-padded, 3-digit test IDs)  
**Status:** ✅ Ready for execution
