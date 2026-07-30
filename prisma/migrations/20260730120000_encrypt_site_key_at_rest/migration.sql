-- The site key is now stored as AES-256-GCM ciphertext (`iv:ciphertext:tag`),
-- not plaintext. The rename is the point: `siteKeyEncrypted` cannot be mistaken
-- for a usable key at a call site, the way `siteKey` could.
--
-- This is a rename, not a re-encrypt: SQLite cannot encrypt, so any row written
-- before this migration keeps its PLAINTEXT value under the new name and will
-- fail decryption on read. That is the intended, loud outcome — the app reports
-- the config as unreadable and asks the merchant to re-enter the key, rather
-- than silently trusting an unencrypted value. See the PR notes.
ALTER TABLE "SourcetrackConfig" RENAME COLUMN "siteKey" TO "siteKeyEncrypted";
