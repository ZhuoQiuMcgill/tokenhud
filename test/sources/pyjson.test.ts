import { describe, expect, test } from "bun:test";
import {
  needsPyJson,
  PyBigInt,
  PyFloat,
  parsePyJson,
  pyStr,
  pyTruthy,
} from "../../src/sources/pyjson.ts";
import { guard } from "../guard.ts";

guard();

describe("parsePyJson keeps Python's number kinds", () => {
  test("floats, integers and big integers", () => {
    const v = parsePyJson(
      '{"a":5.0,"b":5,"c":1e3,"d":-0,"e":123456789012345678901,"f":[2.5]}',
    ) as Record<string, unknown>;
    expect(v.a).toEqual(new PyFloat(5));
    expect(v.b).toBe(5);
    expect(v.c).toEqual(new PyFloat(1000));
    expect(v.d).toBe(-0);
    expect(v.e).toEqual(new PyBigInt(123456789012345678901n));
    expect((v.f as unknown[])[0]).toEqual(new PyFloat(2.5));
  });

  test("needsPyJson flags member values with a fraction, an exponent or 16+ digits", () => {
    expect(needsPyJson('{"input_tokens":5.0}')).toBe(true);
    expect(needsPyJson('{"input_tokens" : 1E3}')).toBe(true);
    expect(needsPyJson('{"id":1234567890123456}')).toBe(true);
    expect(needsPyJson('{"input_tokens":5,"timestamp":"2026-06-01T00:00:00.000Z"}')).toBe(false);
    expect(needsPyJson('{"v":"1.5","n":[1.5]}')).toBe(false);
  });
});

describe("pyStr is Python's str() of a JSON value", () => {
  // Each expected string is what CPython 3.14 prints for the same json.loads value.
  test.each([
    ["s", "s"],
    [null, "None"],
    [true, "True"],
    [false, "False"],
    [12345, "12345"],
    [new PyFloat(5), "5.0"],
    [new PyFloat(1.5), "1.5"],
    [new PyFloat(1e16), "1e+16"],
    [new PyFloat(1e15), "1000000000000000.0"],
    [new PyFloat(0.0001), "0.0001"],
    [new PyFloat(0.00001), "1e-05"],
    [new PyFloat(-0), "-0.0"],
    [new PyFloat(123.456), "123.456"],
    [new PyBigInt(123456789012345678901n), "123456789012345678901"],
    [2.5, "2.5"],
    [{ b: 1, a: [true, null, 2.5, "x'y"] }, "{'b': 1, 'a': [True, None, 2.5, \"x'y\"]}"],
    [
      ["a\nb", "é", " ", "\x7f", "q'\"", "\ud800"],
      "['a\\nb', 'é', '\\xa0', '\\x7f', 'q\\'\"', '\\ud800']",
    ],
  ])("%p -> %p", (value, want) => {
    expect(pyStr(value)).toBe(want);
  });
});

test("pyTruthy is Python's truthiness", () => {
  for (const v of [null, undefined, false, 0, "", [], {}, new PyFloat(0), new PyBigInt(0n)])
    expect(pyTruthy(v)).toBe(false);
  for (const v of [true, 1, -1, "0", [0], { a: 0 }, new PyFloat(0.5), new PyBigInt(10n ** 20n)])
    expect(pyTruthy(v)).toBe(true);
});
