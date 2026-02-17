/**
 * Google Drive Uploader
 * Uploads screenshots and videos to a Shared Drive, returns shareable links.
 *
 * Prerequisites:
 *   1. Enable the Google Drive API in your GCP project.
 *   2. Add the service account email as a Content Manager on the Shared Drive
 *      (e.g. cypress-qa@wastehero-qa-automation.iam.gserviceaccount.com).
 *   3. Set GOOGLE_DRIVE_FOLDER_ID in .env / GitHub secrets.
 */

import { google, drive_v3 } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';

/** Result of a single file upload */
export interface DriveUploadResult {
  /** Original local file path */
  localPath: string;
  /** Google Drive file ID */
  fileId: string;
  /** Direct web-view link (anyone with link can view) */
  webViewLink: string;
  /** File name in Drive */
  name: string;
}

/**
 * Maps test IDs to their uploaded artifact links.
 * Key = test ID (e.g. "FR-020-001"), value = { screenshotUrl, videoUrl }
 */
export interface ArtifactLinks {
  [testId: string]: {
    screenshotUrl?: string;
    videoUrl?: string;
  };
}

/**
 * Google Drive client for uploading Cypress artifacts.
 * Uses `supportsAllDrives: true` on every call so it works with Shared Drives
 * (which avoids the "Service Accounts do not have storage quota" error).
 */
export class GoogleDriveClient {
  private drive: drive_v3.Drive;
  private folderId: string;

  constructor(credentials: object, folderId: string) {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    this.drive = google.drive({ version: 'v3', auth });
    this.folderId = folderId;
  }

  /**
   * Create a subfolder inside the root Drive folder.
   * Returns the new folder's ID. If a folder with the same name already exists
   * it is reused (to avoid duplicates across retries).
   */
  async getOrCreateSubfolder(name: string): Promise<string> {
    // Check if folder already exists
    const query = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      `'${this.folderId}' in parents`,
      `trashed = false`,
    ].join(' and ');

    const existing = await this.drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (existing.data.files && existing.data.files.length > 0) {
      return existing.data.files[0].id!;
    }

    // Create new folder
    const response = await this.drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [this.folderId],
      },
      fields: 'id',
      supportsAllDrives: true,
    });

    return response.data.id!;
  }

  /**
   * Upload a single file to a specific Drive folder.
   */
  async uploadFile(
    localPath: string,
    parentFolderId: string,
    mimeType: string
  ): Promise<DriveUploadResult> {
    const fileName = path.basename(localPath);

    const response = await this.drive.files.create({
      requestBody: {
        name: fileName,
        parents: [parentFolderId],
      },
      media: {
        mimeType,
        body: fs.createReadStream(localPath),
      },
      fields: 'id, name, webViewLink',
      supportsAllDrives: true,
    });

    const fileId = response.data.id!;
    const webViewLink =
      response.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

    return {
      localPath,
      fileId,
      webViewLink,
      name: fileName,
    };
  }

  /**
   * Upload all screenshots and videos from Cypress output directories.
   *
   * Directory layout expected:
   *   cypress/screenshots/<spec-folder>/<file>.png
   *   cypress/videos/<file>.mp4
   *
   * Returns an ArtifactLinks map keyed by test ID.
   */
  async uploadAllArtifacts(
    screenshotsDir: string,
    videosDir: string,
    runLabel: string
  ): Promise<ArtifactLinks> {
    const links: ArtifactLinks = {};

    // Create a run-specific subfolder: "Run 2026-02-16T08-00-00Z"
    const runFolderId = await this.getOrCreateSubfolder(runLabel);

    // --- Upload screenshots ---
    if (fs.existsSync(screenshotsDir)) {
      const screenshotFolderId = await this.getOrCreateSubfolder(`${runLabel}_screenshots`);
      const screenshotFiles = this.collectFiles(screenshotsDir, ['.png', '.jpg', '.jpeg']);

      console.log(`  Uploading ${screenshotFiles.length} screenshot(s)...`);
      for (const file of screenshotFiles) {
        try {
          const result = await this.uploadFile(file, screenshotFolderId, 'image/png');
          const testId = this.extractTestIdFromPath(file);
          if (testId) {
            if (!links[testId]) links[testId] = {};
            // If multiple screenshots per test, keep the last one (usually the failure)
            links[testId].screenshotUrl = result.webViewLink;
          }
          console.log(`    Uploaded: ${result.name}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`    Failed to upload ${path.basename(file)}: ${msg}`);
        }
      }
    } else {
      console.log('  No screenshots directory found, skipping.');
    }

    // --- Upload videos ---
    if (fs.existsSync(videosDir)) {
      const videoFolderId = await this.getOrCreateSubfolder(`${runLabel}_videos`);
      const videoFiles = this.collectFiles(videosDir, ['.mp4']);

      console.log(`  Uploading ${videoFiles.length} video(s)...`);
      for (const file of videoFiles) {
        try {
          const result = await this.uploadFile(file, videoFolderId, 'video/mp4');
          const testId = this.extractTestIdFromVideo(file);
          if (testId) {
            if (!links[testId]) links[testId] = {};
            links[testId].videoUrl = result.webViewLink;
          }
          console.log(`    Uploaded: ${result.name}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`    Failed to upload ${path.basename(file)}: ${msg}`);
        }
      }
    } else {
      console.log('  No videos directory found, skipping.');
    }

    // Save the run folder link for reference
    console.log(`\n  Run folder: https://drive.google.com/drive/folders/${runFolderId}`);

    return links;
  }

  /**
   * Recursively collect files with given extensions from a directory.
   */
  private collectFiles(dir: string, extensions: string[]): string[] {
    const files: string[] = [];
    if (!fs.existsSync(dir)) return files;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectFiles(fullPath, extensions));
      } else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        files.push(fullPath);
      }
    }
    return files;
  }

  /**
   * Extract test ID from a screenshot file path.
   *
   * Cypress screenshot paths look like:
   *   cypress/screenshots/FR-020/FR-020-001.cy.ts/should do something (failed).png
   *   cypress/screenshots/authentication/FR-001-login.cy.ts/... .png
   *
   * We look for FR-XXX-YYY in the path components.
   */
  private extractTestIdFromPath(filePath: string): string | null {
    // Normalize path separators
    const normalized = filePath.replace(/\\/g, '/');

    // Try FR-XXX-YYY pattern
    const match = normalized.match(/FR-(\d+)-(\d+)/);
    if (match) {
      return `FR-${match[1]}-${match[2]}`;
    }

    // Try FR-XXX from folder/file name (for login tests with single-file multi-test)
    const frMatch = normalized.match(/FR-(\d+)/);
    if (frMatch) {
      return `FR-${frMatch[1]}`;
    }

    return null;
  }

  /**
   * Extract test ID from a video file path.
   *
   * Videos are renamed by cypress.config.ts to: FR-020-001-FAILED.mp4 or FR-020-001-PASSED.mp4
   * Original format: FR-020-001.cy.ts.mp4
   */
  private extractTestIdFromVideo(filePath: string): string | null {
    const baseName = path.basename(filePath, '.mp4');
    // Match: FR-020-001-PASSED or FR-020-001-FAILED or FR-020-001
    const match = baseName.match(/FR-(\d+)-(\d+)/);
    if (match) {
      return `FR-${match[1]}-${match[2]}`;
    }

    // Single FR number (e.g., FR-001-login-FAILED.mp4)
    const frMatch = baseName.match(/FR-(\d+)/);
    if (frMatch) {
      return `FR-${frMatch[1]}`;
    }

    return null;
  }
}
