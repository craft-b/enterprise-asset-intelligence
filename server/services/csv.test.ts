// server/services/csv.test.ts
//
// These numbers become training features, so a parser that silently puts the
// right value in the wrong column is worse than one that fails. Most of this
// file is about the cases where `split(",")` would appear to work.

import { describe, it, expect } from "vitest";
import { parseCsv } from "./csv";

describe("parseCsv", () => {
  it("parses a plain file", () => {
    const result = parseCsv("equipment_id,engine_rpm\n1,1800\n2,1650\n");

    expect(result.header).toEqual(["equipment_id", "engine_rpm"]);
    expect(result.rows).toEqual([["1", "1800"], ["2", "1650"]]);
    expect(result.errors).toEqual([]);
  });

  it("keeps a quoted comma inside its field", () => {
    // split(",") puts "E210" and " hydraulic" in different columns and shifts
    // every value after it by one.
    const result = parseCsv('equipment_id,error_codes,engine_rpm\n1,"E210, E455",1800\n');

    expect(result.rows[0]).toEqual(["1", "E210, E455", "1800"]);
  });

  it("handles an escaped quote", () => {
    const result = parseCsv('id,note\n1,"he said ""stop"""\n');
    expect(result.rows[0][1]).toBe('he said "stop"');
  });

  it("handles a newline inside a quoted field", () => {
    const result = parseCsv('id,note\n1,"line one\nline two"\n2,plain\n');

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0][1]).toBe("line one\nline two");
    expect(result.rows[1][0]).toBe("2");
  });

  it("accepts CRLF, which is what Excel writes", () => {
    const result = parseCsv("a,b\r\n1,2\r\n");
    expect(result.rows).toEqual([["1", "2"]]);
    expect(result.rows[0][1]).toBe("2"); // not "2\r"
  });

  it("strips a UTF-8 BOM, which Excel also writes", () => {
    const result = parseCsv("﻿equipment_id,engine_rpm\n1,1800\n");

    expect(result.header[0]).toBe("equipment_id");
    expect(result.header[0].charCodeAt(0)).not.toBe(0xfeff);
  });

  it("tolerates a missing trailing newline", () => {
    expect(parseCsv("a,b\n1,2").rows).toEqual([["1", "2"]]);
  });

  it("skips blank lines mid-file without reporting them", () => {
    const result = parseCsv("a,b\n1,2\n\n3,4\n");

    expect(result.rows).toEqual([["1", "2"], ["3", "4"]]);
    expect(result.errors).toEqual([]);
  });

  it("reports a row with too few values instead of padding it", () => {
    // A short row usually means a stray comma. Padding it silently shifts data.
    const result = parseCsv("a,b,c\n1,2\n");

    expect(result.rows).toHaveLength(0);
    expect(result.errors[0].message).toMatch(/2 value\(s\) but the header has 3/);
    expect(result.errors[0].row).toBe(2);
  });

  it("reports a row with too many values", () => {
    const result = parseCsv("a,b\n1,2,3\n");
    expect(result.errors[0].message).toMatch(/3 value\(s\) but the header has 2/);
  });

  it("reports an unterminated quote rather than guessing", () => {
    const result = parseCsv('a,b\n1,"never closed\n');
    expect(result.errors.some(e => /Unterminated/.test(e.message))).toBe(true);
  });

  it("reports an empty file", () => {
    expect(parseCsv("").errors[0].message).toMatch(/empty/i);
  });

  it("gives line numbers that match an editor", () => {
    const result = parseCsv("a,b\n1,2\n3,4\n");
    // Header is line 1, so data starts at 2.
    expect(result.lineNumbers).toEqual([2, 3]);
  });

  it("counts lines past a multi-line quoted field", () => {
    const result = parseCsv('a,b\n1,"x\ny"\n2,z\n');
    expect(result.lineNumbers[0]).toBe(2);
    expect(result.lineNumbers[1]).toBe(4);
  });

  it("preserves an empty cell as empty rather than dropping it", () => {
    const result = parseCsv("a,b,c\n1,,3\n");
    expect(result.rows[0]).toEqual(["1", "", "3"]);
  });
});
