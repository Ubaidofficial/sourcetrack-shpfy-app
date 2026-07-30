-- CreateTable
CREATE TABLE "SourcetrackConfig" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "siteKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
