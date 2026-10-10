/**
 * Parameterized Snowflake statements. Identifiers are constants defined here; every value is a
 * positional `?` binding supplied by the SQL API adapter.
 */
export type ColumnType = "TEXT" | "NUMBER" | "BOOLEAN" | "TIMESTAMP" | "VARIANT" | "ARRAY";

export interface TableSpec {
  table: "OFFERS" | "NEEDS" | "PROPOSALS" | "OPERATIONS";
  key: string;
  columns: Record<string, ColumnType>;
}

export const TABLES: Record<"offer" | "need" | "group" | "operation", TableSpec> = {
  offer: {
    table: "OFFERS",
    key: "OFFER_ID",
    columns: {
      RETAILER: "TEXT",
      SKU: "TEXT",
      PRODUCT_FAMILY: "TEXT",
      PACKAGE_QUANTITY: "NUMBER",
      TOTAL_CENTS: "NUMBER",
      BASELINES: "VARIANT",
      MEMBERSHIP_REQUIRED: "TEXT",
      PICKUP_ZONE: "TEXT",
      PICKUP_WINDOWS: "ARRAY",
      AVAILABLE: "BOOLEAN",
      EXPIRES_AT: "TIMESTAMP",
      SOURCE_KIND: "TEXT",
      RETRIEVED_AT: "TIMESTAMP",
    },
  },
  need: {
    table: "NEEDS",
    key: "NEED_ID",
    columns: {
      SHOPPER_ID: "TEXT",
      ACCEPTED_OFFER_IDS: "ARRAY",
      QUANTITY: "NUMBER",
      MAX_CONTRIBUTION_CENTS: "NUMBER",
      PICKUP_ZONE: "TEXT",
      PICKUP_WINDOW: "TEXT",
      STATUS: "TEXT",
      CREATED_AT: "TIMESTAMP",
    },
  },
  group: {
    table: "PROPOSALS",
    key: "GROUP_ID",
    columns: {
      OFFER_ID: "TEXT",
      STATUS: "TEXT",
      TOTAL_CENTS: "NUMBER",
      TOTAL_SAVINGS_CENTS: "NUMBER",
      MEMBER_COUNT: "NUMBER",
      ALLOCATIONS: "VARIANT",
      UPDATED_AT: "TIMESTAMP",
    },
  },
  operation: {
    table: "OPERATIONS",
    key: "OPERATION_ID",
    columns: {
      GROUP_ID: "TEXT",
      KIND: "TEXT",
      STATUS: "TEXT",
      AMOUNT_CENTS: "NUMBER",
      PROVIDER_ID: "TEXT",
      UPDATED_AT: "TIMESTAMP",
    },
  },
};

function sourceExpression(type: ColumnType): string {
  switch (type) {
    case "NUMBER":
      return "TO_NUMBER(?)";
    case "BOOLEAN":
      return "TO_BOOLEAN(?)";
    case "TIMESTAMP":
      return "TO_TIMESTAMP_TZ(?)";
    case "VARIANT":
      return "PARSE_JSON(?)";
    case "ARRAY":
      return "PARSE_JSON(?)::ARRAY";
    default:
      return "?";
  }
}

/** Version-guarded upsert: an older ENTITY_VERSION never overwrites a newer row. */
export function mergeStatement(spec: TableSpec): { sql: string; columnOrder: string[] } {
  const columnOrder = ["SESSION_ID", spec.key, "ENTITY_VERSION", ...Object.keys(spec.columns)];
  const select = columnOrder
    .map((column) => {
      const type = spec.columns[column] ?? (column === "ENTITY_VERSION" ? "NUMBER" : "TEXT");
      return `${sourceExpression(type)} AS ${column}`;
    })
    .join(", ");
  const updates = columnOrder
    .filter((column) => column !== "SESSION_ID" && column !== spec.key)
    .map((column) => `t.${column} = s.${column}`)
    .join(", ");
  const sql = [
    `MERGE INTO ${spec.table} t USING (SELECT ${select}) s`,
    `ON t.SESSION_ID = s.SESSION_ID AND t.${spec.key} = s.${spec.key}`,
    `WHEN MATCHED AND s.ENTITY_VERSION > t.ENTITY_VERSION THEN UPDATE SET ${updates}`,
    `WHEN NOT MATCHED THEN INSERT (${columnOrder.join(", ")}) VALUES (${columnOrder.map((c) => `s.${c}`).join(", ")})`,
  ].join("\n");
  return { sql, columnOrder };
}

/** Bindings: session, offer id, initiating need id, initiating shopper, zone, window, limit. */
export const CANDIDATE_NEEDS_SQL = `
SELECT NEED_ID, SHOPPER_ID, ENTITY_VERSION
FROM NEEDS
WHERE SESSION_ID = ?
  AND STATUS = 'forming'
  AND ARRAY_CONTAINS(?::VARIANT, ACCEPTED_OFFER_IDS)
  AND NEED_ID <> ?
  AND SHOPPER_ID <> ?
  AND PICKUP_ZONE = ?
  AND PICKUP_WINDOW = ?
ORDER BY CREATED_AT, NEED_ID
LIMIT ?`;

/** Bindings: session. Open demand per offer and how many full packages it could fill. */
export const DEMAND_SUMMARY_SQL = `
SELECT o.OFFER_ID,
       o.PACKAGE_QUANTITY,
       COUNT(n.NEED_ID) AS OPEN_NEEDS,
       COALESCE(SUM(n.QUANTITY), 0) AS REQUESTED_UNITS,
       FLOOR(COALESCE(SUM(n.QUANTITY), 0) / o.PACKAGE_QUANTITY) AS FILLABLE_PACKAGES
FROM OFFERS o
LEFT JOIN NEEDS n
  ON n.SESSION_ID = o.SESSION_ID
 AND n.STATUS = 'forming'
 AND ARRAY_CONTAINS(o.OFFER_ID::VARIANT, n.ACCEPTED_OFFER_IDS)
WHERE o.SESSION_ID = ?
GROUP BY o.OFFER_ID, o.PACKAGE_QUANTITY
ORDER BY REQUESTED_UNITS DESC, o.OFFER_ID`;
