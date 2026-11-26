import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('firebase-blueprint.json models every collection and DB ID matches firebase-applet-config.json', async () => {
  const blueprint = JSON.parse(await readFile(path.join(root, 'firebase-blueprint.json'), 'utf8'));
  const firebaseConfig = JSON.parse(await readFile(path.join(root, 'firebase.json'), 'utf8'));
  const appletConfig = JSON.parse(await readFile(path.join(root, 'firebase-applet-config.json'), 'utf8'));

  assert.equal(appletConfig.firestoreDatabaseId, firebaseConfig.firestore[0].database);
  assert.ok(blueprint.entities.Inquiry);
  assert.ok(blueprint.entities.AdminUser);
  assert.ok(blueprint.firestore['/inquiries/{inquiryId}']);
  assert.ok(blueprint.firestore['/admins/{adminId}']);
});

test('firestore.rules enforces fail-closed zero-trust baseline and Dirty Dozen invariants', async () => {
  const rules = await readFile(path.join(root, 'firestore.rules'), 'utf8');

  assert.match(rules, /^rules_version\s*=\s*'2';/m);
  assert.match(rules, /match \/\{document=\*\*\}\s*\{\s*allow read, write:\s*if false;/);

  // Structural brace parity check
  const openBraces = (rules.match(/\{/g) || []).length;
  const closeBraces = (rules.match(/\}/g) || []).length;
  assert.equal(openBraces, closeBraces, 'Unbalanced braces in firestore.rules');

  // Admin registry lockdown against self-escalation
  assert.match(rules, /match \/admins\/\{adminId\}/);
  assert.match(rules, /allow create, update, delete:\s*if false;/);
  assert.match(rules, /request\.auth\.token\.email_verified\s*==\s*true/);
  assert.match(rules, /get\(\/databases\/\$\(database\)\/documents\/admins\/\$\(request\.auth\.uid\)\)\.data\.role\s*==\s*'admin'/);

  // Inquiries schema-locked write-once + verified-admin-only PII reads & updates
  assert.match(rules, /match \/inquiries\/\{inquiryId\}/);
  assert.match(rules, /allow create:\s*if isValidInquiryCreate\(inquiryId\);/);
  assert.match(rules, /allow read:\s*if isVerifiedAdmin\(\);/);
  assert.match(rules, /allow update:\s*if isVerifiedAdmin\(\)\s*&&\s*isValidInquiryAdminUpdate\(\);/);
  assert.match(rules, /allow delete:\s*if false;/);

  // Schema & type/bounds enforcement
  assert.match(rules, /incoming\(\)\.keys\(\)\.hasOnly\(/);
  assert.match(rules, /incoming\(\)\.keys\(\)\.hasAll\(/);
  assert.match(rules, /incoming\(\)\.status\s*==\s*'new'/);
  assert.match(rules, /incoming\(\)\.createdAt\s*==\s*request\.time/);
  assert.match(rules, /incoming\(\)\.diff\(existing\(\)\)\.affectedKeys\(\)\.hasOnly\(\['status',\s*'updatedAt'\]\)/);
  assert.match(rules, /isValidId\(inquiryId\)/);
  assert.match(rules, /id\.size\(\)\s*<=\s*128/);
});
