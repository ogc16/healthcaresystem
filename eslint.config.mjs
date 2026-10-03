import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier";
import tailwindcss from "eslint-plugin-tailwindcss";
import neostandard from "neostandard";

/**
 * Flat config replacement for the old `.eslintrc.json`.
 *
 * The old file extended `next/core-web-vitals`, `standard`,
 * `plugin:tailwindcss/recommended`, then `prettier`, so the precedence order
 * below is kept identical and the resulting rule set should match the ESLint 8
 * setup this replaces.
 *
 * `standard` was swapped for `neostandard`, its maintained flat-config
 * successor: `eslint-config-standard@17` hard-pins `eslint@^8.0.1` and cannot
 * load under ESLint 9. `neostandard` targets `eslint@^9` and covers the same
 * rules, so the style baseline is unchanged.
 */
const config = [
  {
    ignores: [".next/**", "out/**", "node_modules/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...neostandard({ ts: true }),
  ...tailwindcss.configs["flat/recommended"],
  prettier,
  {
    rules: {
      // TypeScript resolves these at compile time; the base ruleset assumes a
      // plain JS runtime where they would be genuine errors.
      "no-undef": "off",
      "import/order": [
        "error",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
];

export default config;