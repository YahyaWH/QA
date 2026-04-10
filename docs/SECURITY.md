# Security & Safety Guide for Cypress Testing

This guide covers how to keep your credentials safe and avoid damaging the application under test.

---

## 🔐 Part 1: Keeping Credentials Safe

### ❌ **NEVER Do This**

```typescript
// ❌ DANGER - Hardcoded credentials
describe('Login Test', () => {
  it('should login', () => {
    cy.visit('/login');
    cy.get('[data-testid="email"]').type('myemail@example.com'); // ❌ Exposed!
    cy.get('[data-testid="password"]').type('MyPassword123!'); // ❌ Exposed!
    cy.get('[data-testid="login-btn"]').click();
  });
});
```

**Why this is dangerous:**

- ✅ Credentials visible in code
- ✅ Visible in version control (Git)
- ✅ Visible in CI/CD logs
- ✅ Anyone with repo access can see them

---

## ✅ Solution 1: Environment Variables (.env File)

### **Step 1: Create `.env` file** (Local Development)

```bash
# .env - NEVER commit this file!
TEST_USER_EMAIL=test.user@example.com
TEST_USER_PASSWORD=SecurePassword123!
TEST_ADMIN_EMAIL=admin@example.com
TEST_ADMIN_PASSWORD=AdminPass456!
BASE_URL=https://staging.yourfinanceapp.com
```

### **Step 2: Update `.gitignore`**

```
# Environment files - NEVER commit these!
.env
.env.local
.env.*.local
*.env

# Cypress env files
cypress.env.json
```

### **Step 3: Create `.env.example`** (Template for Team)

```bash
# .env.example - Safe to commit (no real values)
TEST_USER_EMAIL=your-test-email@example.com
TEST_USER_PASSWORD=your-test-password
TEST_ADMIN_EMAIL=admin-email@example.com
TEST_ADMIN_PASSWORD=admin-password
BASE_URL=https://staging.yourfinanceapp.com
```

### **Step 4: Load Environment Variables**

Install dotenv:

```bash
npm install --save-dev dotenv
```

Update `cypress.config.ts`:

```typescript
import { defineConfig } from 'cypress';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export default defineConfig({
  e2e: {
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',

    setupNodeEvents(on, config) {
      // Pass environment variables to Cypress
      config.env.TEST_USER_EMAIL = process.env.TEST_USER_EMAIL;
      config.env.TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD;
      config.env.TEST_ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL;
      config.env.TEST_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD;

      return config;
    },
  },
});
```

### **Step 5: Use in Tests (Secure Way)**

```typescript
// ✅ SAFE - Using environment variables
describe('Login Test', () => {
  it('should login securely', () => {
    cy.visit('/login');

    // Get credentials from environment variables
    cy.get('[data-testid="email"]').type(Cypress.env('TEST_USER_EMAIL'));
    cy.get('[data-testid="password"]').type(Cypress.env('TEST_USER_PASSWORD'));
    cy.get('[data-testid="login-btn"]').click();

    // Verify login
    cy.url().should('include', '/dashboard');
  });
});
```

---

## ✅ Solution 2: Cypress Environment JSON

### **Alternative: Use `cypress.env.json`**

Create `cypress.env.json` (also gitignored):

```json
{
  "TEST_USER_EMAIL": "test@example.com",
  "TEST_USER_PASSWORD": "SecurePass123!",
  "TEST_ADMIN_EMAIL": "admin@example.com",
  "TEST_ADMIN_PASSWORD": "AdminPass456!"
}
```

**Pros:**

- Cypress-native approach
- No extra dependencies
- Automatically loaded by Cypress

**Cons:**

- Separate from other environment variables
- One more file to manage

---

## ✅ Solution 3: CI/CD Secrets (GitHub Actions, GitLab CI)

### **For GitHub Actions**

1. Go to **Repository Settings** → **Secrets and variables** → **Actions**
2. Add secrets:
   - `TEST_USER_EMAIL`
   - `TEST_USER_PASSWORD`
   - `TEST_ADMIN_EMAIL`
   - `TEST_ADMIN_PASSWORD`

3. Use in workflow:

```yaml
# .github/workflows/cypress.yml
name: Cypress Tests

on: [push, pull_request]

jobs:
  cypress-run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Run Cypress Tests
        uses: cypress-io/github-action@v6
        env:
          # Pass secrets to Cypress
          TEST_USER_EMAIL: ${{ secrets.TEST_USER_EMAIL }}
          TEST_USER_PASSWORD: ${{ secrets.TEST_USER_PASSWORD }}
          TEST_ADMIN_EMAIL: ${{ secrets.TEST_ADMIN_EMAIL }}
          TEST_ADMIN_PASSWORD: ${{ secrets.TEST_ADMIN_PASSWORD }}
```

---

## 🛡️ Best Practices for Credentials

### 1. **Use Test-Specific Accounts**

```
❌ DON'T use your real personal account
✅ DO create dedicated test accounts:
   - test.user@yourcompany.com
   - test.admin@yourcompany.com
```

### 2. **Use Different Credentials Per Environment**

```typescript
// cypress.config.ts
const environments = {
  staging: {
    baseUrl: 'https://staging.yourapp.com',
    userEmail: process.env.STAGING_USER_EMAIL,
  },
  production: {
    baseUrl: 'https://yourapp.com',
    userEmail: process.env.PROD_USER_EMAIL, // ❌ Better not to test on prod!
  },
};
```

### 3. **Rotate Test Credentials Regularly**

- Change test passwords every 90 days
- Use password managers (1Password, LastPass) for team sharing
- Never share credentials via email or Slack

### 4. **Use Session Caching for Performance**

```typescript
// cypress/support/commands.ts
Cypress.Commands.add('loginAsUser', () => {
  cy.session(
    ['user-session', Cypress.env('TEST_USER_EMAIL')], // Cache key
    () => {
      cy.visit('/login');
      cy.get('[data-testid="email"]').type(Cypress.env('TEST_USER_EMAIL'));
      cy.get('[data-testid="password"]').type(Cypress.env('TEST_USER_PASSWORD'));
      cy.get('[data-testid="login-btn"]').click();
      cy.url().should('include', '/dashboard');
    },
    {
      validate() {
        // Verify session is still valid
        cy.getCookie('auth_token').should('exist');
      },
    }
  );
});

// Use in tests
describe('Dashboard Test', () => {
  beforeEach(() => {
    cy.loginAsUser(); // Fast, cached login
  });

  it('should display dashboard', () => {
    cy.visit('/dashboard');
    // Test continues...
  });
});
```

---

## 🛠️ Part 2: Not Messing Up the Webpage

### ❌ **Rule #1: NEVER Test on Production**

```typescript
// ❌ DANGER - Testing on production
export default defineConfig({
  e2e: {
    baseUrl: 'https://yourapp.com', // ❌ Real users affected!
  },
});
```

**Why this is dangerous:**

- Creates real transactions
- Deletes real data
- Affects real users
- Can trigger payment processing
- May violate compliance regulations

---

## ✅ **Rule #2: Always Use Staging/Test Environment**

```typescript
// ✅ SAFE - Testing on staging
export default defineConfig({
  e2e: {
    baseUrl: 'https://staging.yourapp.com', // ✅ Safe sandbox
  },
});
```

### **Ideal Environment Setup:**

```
1. Local Development → http://localhost:3000
2. Staging/QA        → https://staging.yourapp.com
3. Production        → https://yourapp.com (NO TESTING!)
```

---

## ✅ **Rule #3: Use Test Data That Can Be Safely Deleted**

### **Example: Namespaced Test Data**

```typescript
// ✅ GOOD - Clearly marked test data
describe('Add Transaction', () => {
  it('should add expense', () => {
    const testTransaction = {
      amount: 50.0,
      category: 'Groceries',
      description: '[TEST] Weekly groceries - AUTO GENERATED',
      date: '2026-02-12',
    };

    cy.get('[data-testid="add-transaction"]').click();
    cy.get('[data-testid="amount"]').type(testTransaction.amount.toString());
    cy.get('[data-testid="description"]').type(testTransaction.description);
    // ... continue test
  });
});
```

**Benefits:**

- Easy to identify test data: Search for `[TEST]`
- Can be bulk-deleted after test runs
- Won't confuse real data

---

## ✅ **Rule #4: Database Seeding & Cleanup**

### **Before Each Test Suite (Seed Data)**

```typescript
// cypress/support/e2e.ts
before(() => {
  // Seed test database with known state
  cy.task('seedDatabase', {
    users: [
      { email: 'test@example.com', role: 'user' },
      { email: 'admin@example.com', role: 'admin' },
    ],
    transactions: [],
    budgets: [],
  });
});
```

### **After Each Test Suite (Cleanup)**

```typescript
after(() => {
  // Clean up test data
  cy.task('cleanupTestData', {
    deleteUsersWithPrefix: '[TEST]',
    deleteTransactionsWithPrefix: '[TEST]',
  });
});
```

### **Implementing Cleanup Tasks**

```typescript
// cypress.config.ts
import { defineConfig } from 'cypress';

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      // Database seeding task
      on('task', {
        seedDatabase(data) {
          // Call your backend API to seed data
          // Example: POST /api/test/seed
          return null;
        },

        cleanupTestData(options) {
          // Call your backend API to cleanup
          // Example: DELETE /api/test/cleanup
          return null;
        },
      });

      return config;
    },
  },
});
```

---

## ✅ **Rule #5: Use API Mocking for Read-Only Pages**

### **Intercept and Mock Responses**

```typescript
describe('Dashboard', () => {
  beforeEach(() => {
    // Mock API responses - no real data created
    cy.intercept('GET', '/api/transactions', {
      fixture: 'transactions.json', // Uses mock data
    }).as('getTransactions');

    cy.intercept('GET', '/api/budgets', {
      fixture: 'budgets.json',
    }).as('getBudgets');

    cy.visit('/dashboard');
    cy.wait(['@getTransactions', '@getBudgets']);
  });

  it('should display dashboard', () => {
    cy.get('[data-testid="transactions-list"]').should('be.visible');
    // Test UI without affecting database
  });
});
```

**Benefits:**

- ✅ No database writes
- ✅ Faster tests
- ✅ Predictable data
- ✅ Safe for any environment

---

## ✅ **Rule #6: Implement Test Isolation**

### **Each Test Should Be Independent**

```typescript
// ✅ GOOD - Test creates its own data
describe('Edit Transaction', () => {
  let transactionId: string;

  beforeEach(() => {
    // Create test transaction
    cy.request('POST', '/api/transactions', {
      amount: 100,
      description: '[TEST] Transaction for editing',
    }).then((response) => {
      transactionId = response.body.id;
    });
  });

  it('should edit transaction', () => {
    cy.visit(`/transactions/${transactionId}/edit`);
    cy.get('[data-testid="amount"]').clear().type('150');
    cy.get('[data-testid="save"]').click();

    // Verify change
    cy.get('[data-testid="amount"]').should('contain', '150');
  });

  afterEach(() => {
    // Clean up test transaction
    cy.request('DELETE', `/api/transactions/${transactionId}`);
  });
});
```

---

## 🎯 Complete Security Checklist

### **Before Running Tests:**

- [ ] ✅ Using `.env` file or `cypress.env.json` for credentials
- [ ] ✅ `.env` is in `.gitignore`
- [ ] ✅ `.env.example` exists for team reference
- [ ] ✅ `baseUrl` points to staging/test environment
- [ ] ✅ Test accounts created (not personal accounts)
- [ ] ✅ Database seeding/cleanup scripts ready
- [ ] ✅ CI/CD secrets configured (GitHub Actions, etc.)

### **During Development:**

- [ ] ✅ Never commit credentials to Git
- [ ] ✅ Test data prefixed with `[TEST]` or similar
- [ ] ✅ Tests are isolated (create/cleanup own data)
- [ ] ✅ Using `cy.session()` for auth caching

### **Before Pushing to Repository:**

```bash
# Check for accidentally committed secrets
git diff HEAD

# Verify .env is not staged
git status | grep -i "\.env"

# If you accidentally committed secrets:
git reset HEAD~1  # Undo last commit (if not pushed)
# Then re-commit without secrets
```

---

## 🚨 Emergency: "I Accidentally Committed Credentials!"

### **If Credentials Are in Git History:**

1. **Immediately rotate credentials** (change passwords)
2. **Remove from Git history:**

   ```bash
   # Remove file from Git history
   git filter-branch --force --index-filter \
     "git rm --cached --ignore-unmatch .env" \
     --prune-empty --tag-name-filter cat -- --all

   # Force push (if already pushed)
   git push origin --force --all
   ```

3. **Notify your team**
4. **Review repository access logs**

---

## 📚 Additional Resources

- **Cypress Environment Variables**: https://docs.cypress.io/guides/guides/environment-variables
- **GitHub Secrets**: https://docs.github.com/en/actions/security-guides/encrypted-secrets
- **Security Best Practices**: https://owasp.org/www-project-top-ten/

---

## 🎯 Quick Reference: Safe Test Pattern

```typescript
// cypress/e2e/transactions/FR-020-add-transaction.cy.ts
import { TransactionsPage } from '@pages/TransactionsPage';

describe('FR-020: Add Transaction', { tags: ['@critical', '@transactions'] }, () => {
  let transactionsPage: TransactionsPage;

  before(() => {
    // Login once using cached session
    cy.loginAsUser();
  });

  beforeEach(() => {
    transactionsPage = new TransactionsPage();
    transactionsPage.visit();
  });

  it('should add expense transaction', () => {
    // Arrange - Use test data from fixture
    cy.fixture('testData').then((data) => {
      const testTransaction = {
        ...data.transactions.expense,
        description: `[TEST] ${data.transactions.expense.description} ${Date.now()}`,
      };

      // Act - Perform test action
      transactionsPage.addTransaction(testTransaction);

      // Assert - Verify result
      transactionsPage.shouldShowSuccessMessage();
      transactionsPage.shouldDisplayTransaction(testTransaction);
    });
  });

  afterEach(() => {
    // Cleanup - Remove test data
    cy.task('cleanupTestTransactions');
  });
});
```

---

## Summary

### **For Credentials:**

✅ Use `.env` files (gitignored)
✅ Use `Cypress.env()` in tests
✅ Use CI/CD secrets for automation
✅ Never hardcode credentials

### **For Safety:**

✅ Never test on production
✅ Always use staging/test environment
✅ Prefix test data with `[TEST]`
✅ Implement cleanup after tests
✅ Use test-specific accounts

**Remember: Security and safety are not optional - they're essential!**
