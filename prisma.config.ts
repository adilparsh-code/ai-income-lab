import "dotenv/config";
import { definePrismaConfig } from "prisma/config";
import { defineConfig as definePostgresConfig } from "@prisma/orm-postgres/config";

const connectionString = (process.env.DIRECT_URL || process.env.DATABASE_URL || "").trim().replace(/^[\"']|[\"']$/g, "");

export default definePrismaConfig({
  orm: definePostgresConfig({
    contract: "prisma8/contract.prisma",
    output: "generated/prisma8",
    ...(connectionString ? { db: { connection: connectionString } } : {}),
  }),
});
