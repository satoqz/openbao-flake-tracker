import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("tests.db");

db.exec(
  `
    UPDATE failures SET package = CASE
      WHEN package LIKE 'github.com/openbao/openbao/api/v2%'
        THEN package
      WHEN package LIKE 'github.com/openbao/openbao/sdk/v2%'
        THEN package
      WHEN package LIKE 'github.com/openbao/openbao/plugins/database%'
        THEN 'github.com/openbao/openbao/v2/internal/builtin/database'
            || SUBSTR(package, LENGTH('github.com/openbao/openbao/plugins/database') + 1)
      WHEN package LIKE 'github.com/openbao/openbao/v2/internal/v2/internal/%'
        THEN 'github.com/openbao/openbao/v2/internal/'
            || SUBSTR(package, LENGTH('github.com/openbao/openbao/v2/internal/v2/internal/') + 1)
      WHEN package LIKE 'github.com/openbao/openbao/%'
          AND package NOT LIKE 'github.com/openbao/openbao/v2%'
        THEN 'github.com/openbao/openbao/v2/internal/'
            || SUBSTR(package, LENGTH('github.com/openbao/openbao/') + 1)
      ELSE package
    END
  `,
);

db.close();
