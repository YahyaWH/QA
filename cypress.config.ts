import { defineConfig } from 'cypress';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables from .env file
dotenv.config();

export default defineConfig({
  // Mochawesome reporter configuration for Google Sheets integration
  reporter: 'mochawesome',
  reporterOptions: {
    reportDir: 'cypress/results/mochawesome',
    overwrite: false,
    html: false,
    json: true,
    timestamp: 'mmddyyyy_HHMMss',
  },

  e2e: {
    // Base URL of the application under test
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',

    // Test files location
    specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',

    // Support file
    supportFile: 'cypress/support/e2e.ts',

    // Viewport settings
    viewportWidth: 1280,
    viewportHeight: 720,

    // Timeouts
    defaultCommandTimeout: 10000,
    pageLoadTimeout: 30000,
    requestTimeout: 10000,

    // Video and screenshot settings
    video: true,
    videosFolder: 'cypress/videos',
    screenshotsFolder: 'cypress/screenshots',
    videoCompression: 32,

    // Retry configuration for CI/CD
    retries: {
      runMode: 0, // No retries – fail fast
      openMode: 0, // No retries in interactive mode
    },

    // Chrome web security (disable if testing cross-origin)
    chromeWebSecurity: true,

    // Add experimentalModifyObstructiveThirdPartyCode to help with stability
    experimentalModifyObstructiveThirdPartyCode: true,

    setupNodeEvents(on, config) {
      // Create results directories if they don't exist
      const dirs = ['cypress/results', 'cypress/results/contexts', 'cypress/results/mochawesome'];
      dirs.forEach((dir) => {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      });

      // Fix for Windows GPU cache permission issues
      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.family === 'chromium' && browser.name !== 'electron') {
          // Add GPU-related flags for Chrome/Edge
          launchOptions.args.push('--disable-gpu');
          launchOptions.args.push('--disable-software-rasterizer');
          launchOptions.args.push('--disable-dev-shm-usage');
        }

        if (browser.name === 'electron') {
          // Electron-specific flags to fix IPC issue
          launchOptions.args.push('--disable-gpu');
          launchOptions.args.push('--disable-software-rasterizer');
          launchOptions.args.push('--no-sandbox');
        }

        return launchOptions;
      });

      // Load environment variables from .env into Cypress.env()
      config.env.TEST_USER_EMAIL = process.env.TEST_USER_EMAIL;
      config.env.TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD;
      config.env.TEST_ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL;
      config.env.TEST_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD;

      // Rename videos with test ID and PASSED/FAILED status
      on('after:spec', (spec, results) => {
        console.log(`Finished running ${spec.name}`);

        // Check if video exists
        if (results.video) {
          const videoPath = results.video;

          // Extract test ID from file name (e.g., FR-020-001.cy.ts -> FR-020-001)
          const specName = path.basename(spec.name, '.cy.ts');

          // Determine overall status
          const status = results.stats.failures > 0 ? 'FAILED' : 'PASSED';

          // Create new video name
          const videoDir = path.dirname(videoPath);
          const newVideoName = `${specName}-${status}.mp4`;
          const newVideoPath = path.join(videoDir, newVideoName);

          // Rename the video file
          try {
            if (fs.existsSync(videoPath)) {
              fs.renameSync(videoPath, newVideoPath);
              console.log(`✅ Video renamed: ${newVideoName}`);
            }
          } catch (error) {
            console.error(`❌ Failed to rename video: ${error}`);
          }
        }
      });

      // Task for logging to console
      on('task', {
        log(message) {
          console.log(message);
          return null;
        },
      });

      return config;
    },

    env: {
      // Environment variables for tests
      // Additional variables can be added here
    },
  },
});
