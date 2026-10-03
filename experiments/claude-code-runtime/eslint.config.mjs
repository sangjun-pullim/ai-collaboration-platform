import parser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts", "test/fixtures/**/*.mjs"],
    languageOptions: { parser, ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-debugger": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-unreachable": "error",
      "constructor-super": "error",
      "valid-typeof": "error"
    }
  }
];
