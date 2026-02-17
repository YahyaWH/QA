/**
 * Google Sheets Uploader
 * Handles all Google Sheets API interactions for test result uploads
 */

import { google, sheets_v4 } from 'googleapis';
import type { TestResult } from '../support/types/test-results';

// Sheet headers -- 17 columns (Error Classification added after Error Stack)
const HEADERS = [
  'Test ID',
  'Description',
  'Status',
  'Duration (ms)',
  'Retry Count',
  'Timestamp',
  'Steps to Reproduce',
  'Screenshot',
  'Video',
  'Console Logs',
  'Network Requests',
  'Error Stack',
  'Error Classification',
  'DOM State',
  'Environment',
  'Browser',
  'Viewport',
];

/**
 * Google Sheets Client class
 */
export class GoogleSheetsClient {
  private sheets: sheets_v4.Sheets;
  private spreadsheetId: string;

  constructor(credentials: object, spreadsheetId: string) {
    // Create auth client
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
      ],
    });

    // Create sheets client
    this.sheets = google.sheets({ version: 'v4', auth });
    this.spreadsheetId = spreadsheetId;
  }

  /**
   * Get all existing sheet names in the spreadsheet
   */
  async getExistingSheets(): Promise<string[]> {
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
    });

    return response.data.sheets?.map((sheet) => sheet.properties?.title || '') || [];
  }

  /**
   * Get sheet ID by name
   */
  async getSheetId(sheetName: string): Promise<number | null> {
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
    });

    const sheet = response.data.sheets?.find((s) => s.properties?.title === sheetName);

    return sheet?.properties?.sheetId ?? null;
  }

  /**
   * Create a new sheet
   */
  async createSheet(sheetName: string): Promise<number> {
    const response = await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName,
              },
            },
          },
        ],
      },
    });

    const sheetId = response.data.replies?.[0]?.addSheet?.properties?.sheetId || 0;
    return sheetId;
  }

  /**
   * Get or create a sheet
   */
  async getOrCreateSheet(sheetName: string): Promise<number> {
    const existingSheetId = await this.getSheetId(sheetName);

    if (existingSheetId !== null) {
      return existingSheetId;
    }

    return await this.createSheet(sheetName);
  }

  /**
   * Clear a sheet completely (data, banding, and filters)
   */
  async clearSheet(sheetName: string): Promise<void> {
    try {
      // Clear data
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1:Z10000`,
      });

      const sheetId = await this.getSheetId(sheetName);
      if (sheetId !== null) {
        // Get existing banded ranges and filters
        const response = await this.sheets.spreadsheets.get({
          spreadsheetId: this.spreadsheetId,
          fields: 'sheets.bandedRanges,sheets.basicFilter,sheets.properties.sheetId',
        });

        const sheet = response.data.sheets?.find((s) => s.properties?.sheetId === sheetId);
        const bandedRanges = sheet?.bandedRanges || [];
        const hasFilter = !!sheet?.basicFilter;

        const requests: sheets_v4.Schema$Request[] = [];

        // Delete banded ranges
        for (const banded of bandedRanges) {
          if (banded.bandedRangeId !== undefined) {
            requests.push({
              deleteBanding: { bandedRangeId: banded.bandedRangeId },
            });
          }
        }

        // Clear filter
        if (hasFilter) {
          requests.push({
            clearBasicFilter: { sheetId },
          });
        }

        if (requests.length > 0) {
          await this.sheets.spreadsheets.batchUpdate({
            spreadsheetId: this.spreadsheetId,
            requestBody: { requests },
          });
        }
      }
    } catch (error) {
      // Sheet might not exist or be empty, which is fine
      console.log(`Note: Could not clear ${sheetName} - may be empty`);
    }
  }

  /**
   * Write headers to a sheet
   */
  async writeHeaders(sheetName: string): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [HEADERS],
      },
    });
  }

  /**
   * Upload test results to a sheet
   */
  async uploadResults(sheetName: string, results: TestResult[]): Promise<void> {
    // Convert results to rows -- must match HEADERS order
    const rows = results.map((r) => [
      r.testId,
      r.description,
      r.status === 'PASSED' ? '✅ PASSED' : '❌ FAILED',
      r.duration,
      r.retryCount,
      r.timestamp,
      r.stepsToReproduce,
      r.screenshotUrl,
      r.videoUrl,
      r.consoleLogs,
      r.networkRequests,
      r.errorStack,
      r.errorClassification,
      r.domStateAtFailure,
      r.environment,
      r.browser,
      r.viewport,
    ]);

    // Write headers first
    await this.writeHeaders(sheetName);

    // Write data rows
    if (rows.length > 0) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: rows,
        },
      });
    }
  }

  /**
   * Apply formatting to a sheet - professional table style with conditional coloring
   */
  async formatSheet(sheetName: string, rowCount: number): Promise<void> {
    const sheetId = await this.getSheetId(sheetName);
    if (sheetId === null) return;

    const numColumns = HEADERS.length;

    const requests: sheets_v4.Schema$Request[] = [
      // Freeze header row
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
      // Header style - dark blue, white text, bold, centered
      {
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: numColumns,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.2, green: 0.4, blue: 0.65 },
              textFormat: {
                bold: true,
                fontSize: 10,
                foregroundColor: { red: 1, green: 1, blue: 1 },
              },
              horizontalAlignment: 'CENTER',
              verticalAlignment: 'MIDDLE',
              wrapStrategy: 'WRAP',
            },
          },
          fields:
            'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
        },
      },
      // Data cells - wrap text, top align
      {
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: rowCount + 1,
            startColumnIndex: 0,
            endColumnIndex: numColumns,
          },
          cell: {
            userEnteredFormat: {
              verticalAlignment: 'TOP',
              wrapStrategy: 'WRAP',
              textFormat: { fontSize: 9 },
            },
          },
          fields: 'userEnteredFormat(verticalAlignment,wrapStrategy,textFormat)',
        },
      },
      // Center Status column
      {
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: rowCount + 1,
            startColumnIndex: 2,
            endColumnIndex: 3,
          },
          cell: {
            userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' },
          },
          fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment)',
        },
      },
      // Center Duration, Retry columns
      {
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: rowCount + 1,
            startColumnIndex: 3,
            endColumnIndex: 5,
          },
          cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
          fields: 'userEnteredFormat.horizontalAlignment',
        },
      },
      // Borders - all cells
      {
        updateBorders: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: rowCount + 1,
            startColumnIndex: 0,
            endColumnIndex: numColumns,
          },
          top: { style: 'SOLID', width: 1, color: { red: 0.8, green: 0.8, blue: 0.8 } },
          bottom: { style: 'SOLID', width: 1, color: { red: 0.8, green: 0.8, blue: 0.8 } },
          left: { style: 'SOLID', width: 1, color: { red: 0.8, green: 0.8, blue: 0.8 } },
          right: { style: 'SOLID', width: 1, color: { red: 0.8, green: 0.8, blue: 0.8 } },
          innerHorizontal: {
            style: 'SOLID',
            width: 1,
            color: { red: 0.85, green: 0.85, blue: 0.85 },
          },
          innerVertical: {
            style: 'SOLID',
            width: 1,
            color: { red: 0.85, green: 0.85, blue: 0.85 },
          },
        },
      },
      // Column widths
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 110 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
          properties: { pixelSize: 280 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 },
          properties: { pixelSize: 90 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 },
          properties: { pixelSize: 85 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 },
          properties: { pixelSize: 70 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 },
          properties: { pixelSize: 140 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 },
          properties: { pixelSize: 250 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 7, endIndex: 9 },
          properties: { pixelSize: 100 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 9, endIndex: 11 },
          properties: { pixelSize: 150 },
          fields: 'pixelSize',
        },
      },
      // Error Stack (col 11)
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 11, endIndex: 12 },
          properties: { pixelSize: 180 },
          fields: 'pixelSize',
        },
      },
      // Error Classification (col 12)
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 12, endIndex: 13 },
          properties: { pixelSize: 250 },
          fields: 'pixelSize',
        },
      },
      // DOM State (col 13)
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 13, endIndex: 14 },
          properties: { pixelSize: 180 },
          fields: 'pixelSize',
        },
      },
      // Environment, Browser, Viewport (cols 14-16)
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 14, endIndex: 17 },
          properties: { pixelSize: 90 },
          fields: 'pixelSize',
        },
      },
      // Header row height
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 35 },
          fields: 'pixelSize',
        },
      },
      // Banded rows (alternating colors)
      {
        addBanding: {
          bandedRange: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: rowCount + 1,
              startColumnIndex: 0,
              endColumnIndex: numColumns,
            },
            rowProperties: {
              firstBandColor: { red: 1, green: 1, blue: 1 },
              secondBandColor: { red: 0.96, green: 0.96, blue: 0.96 },
            },
          },
        },
      },
      // Conditional formatting - green for PASSED
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [
              {
                sheetId,
                startRowIndex: 1,
                endRowIndex: rowCount + 1,
                startColumnIndex: 0,
                endColumnIndex: numColumns,
              },
            ],
            booleanRule: {
              condition: {
                type: 'CUSTOM_FORMULA',
                values: [{ userEnteredValue: '=$C2="✅ PASSED"' }],
              },
              format: { backgroundColor: { red: 0.85, green: 0.95, blue: 0.85 } },
            },
          },
          index: 0,
        },
      },
      // Conditional formatting - red for FAILED
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [
              {
                sheetId,
                startRowIndex: 1,
                endRowIndex: rowCount + 1,
                startColumnIndex: 0,
                endColumnIndex: numColumns,
              },
            ],
            booleanRule: {
              condition: {
                type: 'CUSTOM_FORMULA',
                values: [{ userEnteredValue: '=$C2="❌ FAILED"' }],
              },
              format: { backgroundColor: { red: 0.98, green: 0.85, blue: 0.85 } },
            },
          },
          index: 1,
        },
      },
      // Conditional formatting - Error Classification: BACKEND = orange
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [
              {
                sheetId,
                startRowIndex: 1,
                endRowIndex: rowCount + 1,
                startColumnIndex: 12,
                endColumnIndex: 13,
              },
            ],
            booleanRule: {
              condition: {
                type: 'TEXT_STARTS_WITH',
                values: [{ userEnteredValue: 'BACKEND' }],
              },
              format: {
                backgroundColor: { red: 1, green: 0.95, blue: 0.88 },
                textFormat: { foregroundColor: { red: 0.9, green: 0.4, blue: 0 } },
              },
            },
          },
          index: 2,
        },
      },
      // Conditional formatting - Error Classification: FRONTEND = blue
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [
              {
                sheetId,
                startRowIndex: 1,
                endRowIndex: rowCount + 1,
                startColumnIndex: 12,
                endColumnIndex: 13,
              },
            ],
            booleanRule: {
              condition: {
                type: 'TEXT_STARTS_WITH',
                values: [{ userEnteredValue: 'FRONTEND' }],
              },
              format: {
                backgroundColor: { red: 0.89, green: 0.95, blue: 1 },
                textFormat: { foregroundColor: { red: 0.1, green: 0.4, blue: 0.8 } },
              },
            },
          },
          index: 3,
        },
      },
      // Conditional formatting - Error Classification: INCONCLUSIVE = gray
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [
              {
                sheetId,
                startRowIndex: 1,
                endRowIndex: rowCount + 1,
                startColumnIndex: 12,
                endColumnIndex: 13,
              },
            ],
            booleanRule: {
              condition: {
                type: 'TEXT_STARTS_WITH',
                values: [{ userEnteredValue: 'INCONCLUSIVE' }],
              },
              format: {
                backgroundColor: { red: 0.96, green: 0.96, blue: 0.96 },
                textFormat: { foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } },
              },
            },
          },
          index: 4,
        },
      },
      // Add filter
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: rowCount + 1,
              startColumnIndex: 0,
              endColumnIndex: numColumns,
            },
          },
        },
      },
    ];

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests },
    });
  }

  /**
   * Create and populate the README sheet
   */
  async createReadmeSheet(content: string[][]): Promise<void> {
    const sheetName = 'README';

    await this.getOrCreateSheet(sheetName);
    await this.clearSheet(sheetName);

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: content,
      },
    });

    const sheetId = await this.getSheetId(sheetName);
    if (sheetId !== null) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [
            {
              updateDimensionProperties: {
                range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
                properties: { pixelSize: 800 },
                fields: 'pixelSize',
              },
            },
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: true, fontSize: 18 },
                  },
                },
                fields: 'userEnteredFormat.textFormat',
              },
            },
          ],
        },
      });
    }
  }
}
