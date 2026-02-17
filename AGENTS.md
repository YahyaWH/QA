# AGENTS.md - Finance Tracker Cypress Testing Guide

This document provides coding guidelines and conventions for AI agents working on this Cypress E2E testing project.

---

## 🚀 Commands

### Installation

```bash
npm install
```

### Running Tests

```bash
# Open Cypress Test Runner (interactive mode)
npm run cypress:open

# Run all tests (headless)
npm test
npm run cypress:run

# Run tests in specific browser
npm run cypress:run:chrome
npm run cypress:run:firefox
npm run cypress:run:edge

# Run tests with browser visible
npm run test:headed

# Run a single test file
npm run test:spec "cypress/e2e/authentication/FR-001-login.cy.ts"

# Run tests by tag
npm run test:smoke      # Run smoke tests
npm run test:critical   # Run critical tests
npm run test:regression # Run regression tests
```

### Linting & Formatting

```bash
# Run ESLint
npm run lint

# Fix ESLint issues automatically
npm run lint:fix

# Format all files with Prettier
npm run format

# Check formatting without modifying files
npm run format:check

# TypeScript type checking
npm run type-check
```

---

## 📁 Project Structure

```
cypress/
├── e2e/                          # Test files organized by feature area
│   ├── authentication/           # FR-001 to FR-009
│   ├── dashboard/                # FR-010 to FR-019
│   ├── transactions/             # FR-020 to FR-029
│   ├── budgets/                  # FR-030 to FR-039
│   └── reports/                  # FR-040 to FR-049
├── fixtures/                     # Test data (JSON files)
├── support/
│   ├── commands.ts               # Custom Cypress commands
│   ├── e2e.ts                    # Global hooks and setup
│   ├── page-objects/             # Page Object Models (POMs)
│   └── helpers/                  # Utility functions
```

---

## 📝 Code Style Guidelines

### File Naming Conventions

- **Test files**: `FR-{ID}-{description}.cy.ts` (e.g., `FR-020-add-transaction.cy.ts`)
- **Page Objects**: `PascalCase.ts` (e.g., `LoginPage.ts`, `DashboardPage.ts`)
- **Helper files**: `camelCase.ts` (e.g., `dataGenerators.ts`, `apiHelpers.ts`)
- **Fixtures**: `camelCase.json` (e.g., `testData.json`, `mockResponses.json`)

### Import Organization

Always organize imports in this order:

1. External libraries (Cypress)
2. Page Objects (using @pages alias)
3. Support utilities (using @support alias)
4. Fixtures (using @fixtures alias)
5. Relative imports

Example:

```typescript
import { LoginPage } from '@pages/LoginPage';
import { DashboardPage } from '@pages/DashboardPage';
import { generateTransaction } from '@support/helpers/dataGenerators';
```

### TypeScript Guidelines

- **Always use strict typing** - avoid `any` unless absolutely necessary
- **Explicit return types** for functions (optional for Cypress commands)
- **Interface over type** for object shapes
- **Const assertions** for test data when appropriate

Example:

```typescript
interface Transaction {
  amount: number;
  category: string;
  type: 'income' | 'expense';
}

const createTransaction = (data: Transaction): void => {
  cy.get('[data-testid="amount"]').type(data.amount.toString());
};
```

### Test Structure

Use the **Arrange-Act-Assert (AAA)** pattern:

```typescript
it('should add transaction successfully', () => {
  // Arrange - Setup test data and preconditions
  cy.fixture('testData').then((data) => {
    const transaction = data.transactions.expense;

    // Act - Perform the action being tested
    transactionPage.addTransaction(transaction);

    // Assert - Verify expected outcomes
    transactionPage.shouldShowSuccessMessage();
    transactionPage.shouldDisplayTransaction(transaction);
  });
});
```

### Selectors

- **Prefer `data-testid` attributes** for test stability
- Use semantic selectors as fallback: `button[type="submit"]`
- Avoid CSS classes and IDs that may change

Example:

```typescript
// Good
cy.get('[data-testid="login-button"]').click();

// Acceptable fallback
cy.get('button[type="submit"]').contains('Login').click();

// Avoid
cy.get('.btn-primary').click(); // CSS classes can change
cy.get('#loginBtn').click(); // IDs may not be unique
```

### Naming Conventions

- **Test descriptions**: Use clear, descriptive language starting with "should"
- **Variables**: `camelCase` (e.g., `transactionPage`, `userData`)
- **Classes**: `PascalCase` (e.g., `LoginPage`, `TransactionHelper`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `MAX_RETRIES`, `DEFAULT_TIMEOUT`)
- **Private class members**: Prefix with `private readonly` for selectors

Example:

```typescript
export class LoginPage {
  private readonly emailInput = '[data-testid="email"]';

  fillEmail(email: string) {
    cy.get(this.emailInput).type(email);
  }
}
```

### Error Handling & Assertions

- **Use Cypress built-in assertions** - they auto-retry
- **Chain assertions** when verifying multiple conditions
- **Custom error messages** for complex assertions

Example:

```typescript
// Good - Clear assertion with custom message
cy.get('[data-testid="balance"]')
  .should('be.visible')
  .and('contain', '$1,234.56', 'Balance should display correctly');

// Avoid - Trying to catch errors with try/catch (doesn't work with Cypress)
try {
  cy.get('[data-testid="element"]').click();
} catch (e) {
  // This won't work as expected in Cypress
}
```

### Formatting Rules (Prettier)

- **Semicolons**: Always use
- **Quotes**: Single quotes for strings
- **Line length**: Max 100 characters
- **Trailing commas**: ES5 style
- **Indentation**: 2 spaces (no tabs)
- **Arrow function parens**: Always include

---

## 🏗️ Page Object Model Pattern

Create reusable page objects for each page:

```typescript
export class TransactionPage {
  // Selectors as private readonly properties
  private readonly addBtn = '[data-testid="add-transaction"]';

  // Actions - return 'this' for method chaining
  clickAdd() {
    cy.get(this.addBtn).click();
    return this;
  }

  // Assertions - prefix with 'should'
  shouldShowTransaction(amount: string) {
    cy.contains(amount).should('be.visible');
    return this;
  }
}
```

---

## 🧪 Test Organization

### Test Suite Structure

```typescript
describe('FR-XXX: Feature Name', { tags: ['@priority', '@category'] }, () => {
  // Setup
  beforeEach(() => {
    // Common setup for all tests
  });

  context('Happy Path', () => {
    it('should perform main functionality', () => {});
  });

  context('Edge Cases', () => {
    it('should handle edge case 1', () => {});
  });

  context('Error Handling', () => {
    it('should show error for invalid input', () => {});
  });

  context('Regression: Related Features', () => {
    it('should not break feature X', () => {});
  });
});
```

### Test Tags

Use tags for test organization:

- `@critical` - Must pass before deployment
- `@smoke` - Quick validation tests (5-10 min)
- `@regression` - Full test suite
- `@{feature}` - Feature-specific (e.g., @authentication, @transactions)

---

## 🔧 Custom Commands

Define reusable commands in `cypress/support/commands.ts`:

```typescript
Cypress.Commands.add('login', (email: string, password: string) => {
  cy.session([email, password], () => {
    // Login implementation
  });
});

// TypeScript declaration
declare global {
  namespace Cypress {
    interface Chainable {
      login(email: string, password: string): Chainable<void>;
    }
  }
}
```

---

## 🔐 Security & Safety Best Practices

### Protecting Credentials

- **NEVER hardcode** email, passwords, or API keys in test files
- **USE environment variables**: Store credentials in `.env` file (gitignored)
- **ACCESS via Cypress.env()**: `Cypress.env('TEST_USER_EMAIL')`
- **CREATE .env from template**: Copy `.env.example` to `.env` and fill in values
- **USE test-specific accounts**: Never use personal or production accounts

### Protecting the Application

- **NEVER test on production** - Always use staging/test environment
- **PREFIX test data**: Use `[TEST]` in descriptions to identify test data
- **IMPLEMENT cleanup**: Delete test data after each test (afterEach hook)
- **USE API mocking**: When possible, mock responses to avoid database writes
- **VERIFY environment**: Check baseUrl before running destructive tests

### Example Secure Pattern

```typescript
// ✅ GOOD
describe('Login Test', () => {
  it('should login securely', () => {
    const email = Cypress.env('TEST_USER_EMAIL');
    const password = Cypress.env('TEST_USER_PASSWORD');
    cy.login(email, password);
  });
});

// ❌ BAD - Never do this!
// cy.login('myemail@test.com', 'mypassword123');
```

**See SECURITY.md for comprehensive security guidelines**

---

## 📊 Best Practices

1. **Keep tests independent** - Each test should run in isolation
2. **Use fixtures** for test data - Avoid hardcoding values
3. **Implement Page Objects** - Keep tests DRY and maintainable
4. **Tag appropriately** - Enable filtered test runs
5. **Write descriptive test names** - Make failures easy to diagnose
6. **Use cy.session()** for authentication - Faster test execution
7. **Avoid cy.wait(ms)** - Use proper assertions instead
8. **Take screenshots on failure** - Already configured in e2e.ts
9. **Never commit credentials** - Use .env files and Cypress.env()
10. **Always test on staging** - Never run tests against production

---

## 🎯 Testing 60 Functional Requirements

Map each FR to a test file:

- Create one test file per FR: `FR-{ID}-{description}.cy.ts`
- Group related FRs in feature folders
- Include regression tests for interdependent features
- Maintain traceability matrix (spreadsheet/doc) for coverage tracking

---

## 📚 Resources

- Cypress Docs: https://docs.cypress.io
- TypeScript Guide: https://www.typescriptlang.org/docs/
- This project's structure follows Cypress best practices for enterprise E2E testing
