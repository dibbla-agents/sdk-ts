/**
 * Google Sheets functions - read and update spreadsheets
 */

import * as sdk from '../../src/index';
import { z } from '../../src/index';

// ============================================================================
// SCHEMAS
// ============================================================================

const ReadGoogleSheetsInput = z.object({
  url: z.string().describe('The full Google Sheets URL (e.g., "https://docs.google.com/spreadsheets/d/1abc.../edit")'),
});

const SheetContent = z.object({
  sheetName: z.string().describe('Name of the sheet tab'),
  cells: z.string().describe('JSON object mapping cell references to values (e.g., {"A1": "Name", "B1": "Age"})'),
  rowCount: z.number().describe('Number of rows with data'),
  colCount: z.number().describe('Number of columns with data'),
});

const ReadGoogleSheetsOutput = z.object({
  sheetContents: z.array(SheetContent).describe('Array of sheets with their contents'),
  spreadsheetId: z.string().describe('The unique spreadsheet identifier'),
  title: z.string().describe('The spreadsheet title'),
});

const UpdateGoogleSheetsInput = z.object({
  url: z.string().describe('The full Google Sheets URL'),
  sheetName: z.string().describe('Name of the sheet tab to update (e.g., "Sheet1")'),
  range: z.string().describe('The cell range in A1 notation (e.g., "A1", "A1:C3", "A:A")'),
  values: z.string().describe('A JSON 2D array matching the range dimensions (e.g., [["a", "b"], ["c", "d"]])'),
});

const UpdateGoogleSheetsOutput = z.object({
  updatedRange: z.string().describe('The actual range that was updated'),
  updatedRows: z.number().describe('Number of rows updated'),
  updatedColumns: z.number().describe('Number of columns updated'),
  updatedCells: z.number().describe('Total number of cells updated'),
  spreadsheetId: z.string().describe('The spreadsheet identifier'),
});

// ============================================================================
// GOOGLE SHEETS API TYPES
// ============================================================================

interface SheetValuesResponse {
  values?: string[][];
}

interface SpreadsheetMetadata {
  properties: { title: string };
  sheets: Array<{ properties: { title: string } }>;
}

interface UpdateValuesResponse {
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
  spreadsheetId: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function parseSpreadsheetId(sheetsUrl: string): string {
  const url = new URL(sheetsUrl);
  
  if (!url.host.includes('docs.google.com')) {
    throw new Error(`Not a Google Sheets URL: host is ${url.host}`);
  }
  
  const match = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match || !match[1]) {
    throw new Error(`Could not find spreadsheet ID in URL path: ${url.pathname}`);
  }
  
  return match[1];
}

function colIndexToLetter(col: number): string {
  let result = '';
  while (col >= 0) {
    result = String.fromCharCode('A'.charCodeAt(0) + (col % 26)) + result;
    col = Math.floor(col / 26) - 1;
  }
  return result;
}

async function getSpreadsheetMetadata(accessToken: string, spreadsheetId: string): Promise<SpreadsheetMetadata> {
  const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  
  const response = await fetch(apiUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });
  
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API request failed with status ${response.status}: ${body}`);
  }
  
  return response.json() as Promise<SpreadsheetMetadata>;
}

async function getSheetValuesAsJson(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string
): Promise<{ cellsJson: string; rowCount: number; colCount: number }> {
  const encodedSheetName = encodeURIComponent(sheetName);
  const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedSheetName}`;
  
  const response = await fetch(apiUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });
  
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API request failed with status ${response.status}: ${body}`);
  }
  
  const data = await response.json() as SheetValuesResponse;
  const values: string[][] = data.values || [];
  
  const cells: Record<string, string> = {};
  let colCount = 0;
  
  for (let rowIdx = 0; rowIdx < values.length; rowIdx++) {
    const row = values[rowIdx];
    if (row.length > colCount) {
      colCount = row.length;
    }
    for (let colIdx = 0; colIdx < row.length; colIdx++) {
      const value = row[colIdx];
      if (value !== '') {
        const cellRef = `${colIndexToLetter(colIdx)}${rowIdx + 1}`;
        cells[cellRef] = value;
      }
    }
  }
  
  return {
    cellsJson: JSON.stringify(cells),
    rowCount: values.length,
    colCount,
  };
}

async function updateSheetValues(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  values: unknown[][]
): Promise<UpdateValuesResponse> {
  const encodedRange = encodeURIComponent(range);
  const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}?valueInputOption=USER_ENTERED`;
  
  const response = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      range,
      values,
    }),
  });
  
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API request failed with status ${response.status}: ${body}`);
  }
  
  return response.json() as Promise<UpdateValuesResponse>;
}

// ============================================================================
// FUNCTION DEFINITIONS
// ============================================================================

export const readGoogleSheetsFn = sdk.newFunction({
  name: 'read_google_sheets',
  version: '1.0.0',
  description: `Reads all sheets from a Google Sheets spreadsheet.

INPUT:
- url: The full Google Sheets URL (e.g., "https://docs.google.com/spreadsheets/d/1abc.../edit")

OUTPUT:
- title: The spreadsheet title
- spreadsheet_id: The unique spreadsheet identifier
- sheet_contents: Array of sheets, each containing:
  - sheet_name: Name of the sheet tab
  - cells: JSON object mapping cell references to values (e.g., {"A1": "Name", "B1": "Age"})
  - row_count: Number of rows with data
  - col_count: Number of columns with data

Note: Empty cells are omitted from the cells object.`,
  input: ReadGoogleSheetsInput,
  output: ReadGoogleSheetsOutput,
  handler: async (input, event, state) => {
    await state.rpc?.sendStatusEvent(event, 'Reading Google Sheets...', { url: input.url });

    if (!state.oauth) {
      throw new Error('OAuth client not available');
    }

    const spreadsheetId = parseSpreadsheetId(input.url);
    const token = await state.oauth.getAccessToken('google', event.run);
    const metadata = await getSpreadsheetMetadata(token.accessToken, spreadsheetId);

    const sheetContents: z.infer<typeof SheetContent>[] = [];
    
    for (const sheet of metadata.sheets) {
      await state.rpc?.sendStatusEvent(event, `Reading sheet: ${sheet.properties.title}`, {
        spreadsheetId,
        sheetName: sheet.properties.title,
      });

      const { cellsJson, rowCount, colCount } = await getSheetValuesAsJson(
        token.accessToken,
        spreadsheetId,
        sheet.properties.title
      );

      sheetContents.push({
        sheetName: sheet.properties.title,
        cells: cellsJson,
        rowCount,
        colCount,
      });
    }

    await state.rpc?.sendStatusEvent(event, 'Finished reading Google Sheets', {
      spreadsheetId,
      sheetsRead: sheetContents.length,
    });

    return {
      sheetContents,
      spreadsheetId,
      title: metadata.properties.title,
    };
  },
});

export const updateGoogleSheetsFn = sdk.newFunction({
  name: 'update_google_sheets',
  version: '1.0.0',
  description: `Updates cells in a Google Sheets spreadsheet.

INPUT:
- url: The full Google Sheets URL
- sheet_name: The name of the sheet tab to update (e.g., "Sheet1")
- range: The cell range in A1 notation. Examples:
  - "A1" for a single cell
  - "A1:C3" for a 3x3 range
  - "A:A" for entire column A
- values: A JSON 2D array matching the range dimensions. Examples:
  - Single cell: [["new value"]]
  - Row of 3 cells: [["a", "b", "c"]]
  - 2x2 grid: [["a", "b"], ["c", "d"]]
  - Formula: [["=SUM(A1:A10)"]]

OUTPUT:
- updated_range: The actual range that was updated
- updated_rows: Number of rows updated
- updated_columns: Number of columns updated
- updated_cells: Total number of cells updated
- spreadsheet_id: The spreadsheet identifier

Note: Values are parsed like user input—formulas execute, dates are recognized.`,
  input: UpdateGoogleSheetsInput,
  output: UpdateGoogleSheetsOutput,
  handler: async (input, event, state) => {
    await state.rpc?.sendStatusEvent(event, 'Updating Google Sheets...', {
      sheetName: input.sheetName,
      range: input.range,
    });

    if (!state.oauth) {
      throw new Error('OAuth client not available');
    }

    const spreadsheetId = parseSpreadsheetId(input.url);

    let values: unknown[][];
    try {
      values = JSON.parse(input.values);
    } catch {
      throw new Error(`Failed to parse values JSON: ${input.values}`);
    }

    const token = await state.oauth.getAccessToken('google', event.run);
    const fullRange = `${input.sheetName}!${input.range}`;
    const result = await updateSheetValues(token.accessToken, spreadsheetId, fullRange, values);

    await state.rpc?.sendStatusEvent(event, 'Google Sheets updated successfully', {
      updatedCells: result.updatedCells,
      updatedRange: result.updatedRange,
    });

    return {
      updatedRange: result.updatedRange,
      updatedRows: result.updatedRows,
      updatedColumns: result.updatedColumns,
      updatedCells: result.updatedCells,
      spreadsheetId: result.spreadsheetId,
    };
  },
});

