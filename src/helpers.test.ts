import { describe, expect, test } from "@jest/globals";
import {extractLastJSON} from "./helpers";

interface SimpleType {
    a: number;
    b: number;
}

interface MoreComplexType {
    a: number;
    b: number;
    c: {
        d: string;
        e: string;
    }
}

const expected: SimpleType = { a: 540, b: 45 };

const runAssertions = (actual: string | null) => {
    expect(actual).not.toBeNull();

    if (actual !== null) {
        const json = JSON.parse(actual) as SimpleType;
        expect(json.a).toBe(expected.a);
        expect(json.b).toBe(expected.b);
    }
};

describe("test JSON extraction", () => {
    test("basic", async () => {
        const actual =
            extractLastJSON(`
A 
multi
line 
string
{ "a": 540, "b": 45 }`);

        runAssertions(actual);
    });

    test("multiple json", async () => {
        const actual = extractLastJSON(
            `{ "a": 5400, "b": 450 }{ "a": 540, "b": 45 }`
        );

        console.log("actual", actual);

        runAssertions(actual);
    });

    test("with single backtick at end", async () => {
        const actual =
            extractLastJSON(`
A 
multi
line 
string
  \`{ "a": 540, "b": 45 }\``);

        runAssertions(actual);
    });

    test("with multiple backticks", async () => {
        const actual =
            extractLastJSON(`
A 
multi
line 
string
  \`\`\`json
{ "a": 540, "b": 45 }
\`\`\``);

        runAssertions(actual);
    });

    test("multiline json with backticks", async () => {
        const actual =
            extractLastJSON(`
A 
multi
line 
string
  \`\`\`json
{ 
  "a": 540, 
  "b": 45
}
\`\`\``);

        runAssertions(actual);
    });

    test("multiline json without backticks", async () => {
        const actual =
            extractLastJSON(`A 
multi
line 
string

{ 
  "a": 540, 
  "b": 45
}
`);

        runAssertions(actual);
    });

    test("nested object", async () => {

        const actual =
            extractLastJSON(`A 
multi
line 
string

{ 
  "a": 540, 
  "b": 45,
  "c": {
     "d": "hi",
     "e": "{hi}"
  }
}
`);

        expect(actual).not.toBeNull();

        if (actual !== null) {
            const json = JSON.parse(actual) as MoreComplexType;
            expect(json.a).toBe(expected.a);
            expect(json.b).toBe(expected.b);
            expect(json.c.d).toBe("hi");
            expect(json.c.e).toBe("{hi}");
        }
    });
});
