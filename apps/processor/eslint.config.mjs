export default [
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@pagespace/db"],
              message:
                "Use subpath imports: @pagespace/db/db, @pagespace/db/operators, or @pagespace/db/schema/<name>",
            },
            {
              group: ["@pagespace/lib"],
              message:
                "Use direct subpath imports: @pagespace/lib/<module>/<file>",
            },
          ],
        },
      ],
    },
  },
];
