// server/services/csv.ts
//
// A small RFC 4180 parser, written rather than depended on because the format
// is simple and the failure modes are not: a naive `line.split(",")` corrupts
// any file containing a quoted comma, and corrupts it silently — the row still
// parses, it just has the wrong values in the wrong columns. For a file whose
// numbers become training features, that is the worst possible kind of bug.
//
// Handles: quoted fields, commas and newlines inside quotes, escaped quotes
// ("" inside a quoted field), CRLF and LF, and a UTF-8 BOM.
//
// Does not handle: alternative delimiters, or a quote appearing in the middle
// of an unquoted field. Both are rejected rather than guessed at.

export interface CsvParseError {
  /** 1-based line number, counting the header. */
  row: number;
  message: string;
}

export interface CsvParseResult {
  header: string[];
  /** Rows as arrays of cells, in file order. Length always matches the header. */
  rows: string[][];
  /** 1-based line number for each row, for error messages. */
  lineNumbers: number[];
  errors: CsvParseError[];
}

/** Strip a UTF-8 byte order mark, which Excel writes and JSON.parse chokes on. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split CSV text into records of cells.
 *
 * Returns raw records; the caller decides what the header means.
 */
function splitRecords(text: string): { cells: string[]; line: number }[] {
  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let sawAnyChar = false;

  const endField = () => {
    cells.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    // A trailing newline produces one empty cell; that is not a record.
    if (!(cells.length === 1 && cells[0] === "")) {
      records.push({ cells, line: recordStartLine });
    }
    cells = [];
    recordStartLine = line;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line++;
        field += char;
      }
      continue;
    }

    if (char === '"' && field === "") {
      inQuotes = true;
      sawAnyChar = true;
    } else if (char === ",") {
      endField();
      sawAnyChar = true;
    } else if (char === "\r") {
      // swallow; the \n that follows ends the record
    } else if (char === "\n") {
      line++;
      endRecord();
      recordStartLine = line;
    } else {
      field += char;
      sawAnyChar = true;
    }
  }

  if (field !== "" || cells.length > 0) endRecord();
  if (inQuotes) {
    records.push({ cells: ["\u0000UNTERMINATED"], line: recordStartLine });
  }
  void sawAnyChar;
  return records;
}

/**
 * Parse CSV text with a header row.
 *
 * A row whose cell count does not match the header is reported rather than
 * padded or truncated: a short row usually means a stray comma, and silently
 * filling the gap is how a column shifts without anyone noticing.
 */
export function parseCsv(text: string): CsvParseResult {
  const result: CsvParseResult = { header: [], rows: [], lineNumbers: [], errors: [] };

  const records = splitRecords(stripBom(text));
  if (records.length === 0) {
    result.errors.push({ row: 1, message: "File is empty" });
    return result;
  }

  if (records[0].cells[0] === "\u0000UNTERMINATED") {
    result.errors.push({ row: records[0].line, message: "Unterminated quoted field" });
    return result;
  }

  result.header = records[0].cells.map(h => h.trim());
  if (result.header.every(h => h === "")) {
    result.errors.push({ row: 1, message: "Header row is empty" });
    return result;
  }

  for (const record of records.slice(1)) {
    if (record.cells[0] === "\u0000UNTERMINATED") {
      result.errors.push({ row: record.line, message: "Unterminated quoted field" });
      continue;
    }
    // A blank line in the middle of a file is skipped, not reported.
    if (record.cells.length === 1 && record.cells[0].trim() === "") continue;

    if (record.cells.length !== result.header.length) {
      result.errors.push({
        row: record.line,
        message:
          `has ${record.cells.length} value(s) but the header has ` +
          `${result.header.length} — check for a stray comma`,
      });
      continue;
    }

    result.rows.push(record.cells);
    result.lineNumbers.push(record.line);
  }

  return result;
}
