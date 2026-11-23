#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# RavanaTek Multi-Site-Safe GCP & Firebase Setup Script (Google Cloud Shell)
# Project: ravanatek | Hosting Site: ravanatek.web.app | Cloud Run: ravanatek-backend
# Region: asia-southeast1 | Safe for sibling sites: raone-ai, raone-suva-seva
# ==============================================================================

PROJECT_ID="${PROJECT_ID:-ravanatek}"
REGION="${REGION:-asia-southeast1}"
AR_REPO="${AR_REPO:-cloud-run-source-deploy}"
SERVICE_NAME="${SERVICE_NAME:-ravanatek-backend}"
FIRESTORE_DB="${FIRESTORE_DB:-ravanatek-db}"
RUNTIME_SA_NAME="ravanatek-backend-sa"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_SA_NAME="${DEPLOYER_SA_NAME:-ravanatek-github-deployer}"
DEPLOYER_SA="${DEPLOYER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
STORAGE_BUCKET="${STORAGE_BUCKET:-ravanatek.firebasestorage.app}"

echo "==> Targeting GCP Project: ${PROJECT_ID} (${REGION})"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "==> [1/6] Checking existing Hosting sites, Cloud Run services, and Firestore databases (read-only)..."
firebase hosting:sites:list --project "${PROJECT_ID}" || true
gcloud run services list --project "${PROJECT_ID}" --platform=managed || true
gcloud firestore databases list --project "${PROJECT_ID}" || true

echo "==> [2/6] Enabling required GCP & Firebase APIs (idempotent)..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  firebasehosting.googleapis.com \
  storage.googleapis.com \
  logging.googleapis.com \
  --project="${PROJECT_ID}"

echo "==> [3/6] Ensuring Artifact Registry repository '${AR_REPO}' in ${REGION}..."
if ! gcloud artifacts repositories describe "${AR_REPO}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Docker images for Cloud Run in ${PROJECT_ID}" \
    --project="${PROJECT_ID}"
else
  echo "Artifact Registry repo '${AR_REPO}' already exists."
fi

echo "==> [3b/6] Ensuring dedicated Firestore database '${FIRESTORE_DB}' in ${REGION} (Standard Native)..."
if ! gcloud firestore databases describe --database="${FIRESTORE_DB}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud firestore databases create \
    --database="${FIRESTORE_DB}" \
    --location="${REGION}" \
    --type=firestore-native \
    --project="${PROJECT_ID}"
else
  echo "Firestore database '${FIRESTORE_DB}' already exists."
fi

echo "==> [4/6] Creating / verifying Cloud Run Runtime Service Account: ${RUNTIME_SA}..."
if ! gcloud iam service-accounts describe "${RUNTIME_SA}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${RUNTIME_SA_NAME}" \
    --display-name="RavanaTek Cloud Run Backend Runtime" \
    --project="${PROJECT_ID}"
fi

for ROLE in roles/datastore.user roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="${ROLE}" \
    --condition=None >/dev/null
done

if gcloud storage buckets describe "gs://${STORAGE_BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets add-iam-policy-binding "gs://${STORAGE_BUCKET}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/storage.objectUser" >/dev/null || true
  gcloud storage buckets add-iam-policy-binding "gs://${STORAGE_BUCKET}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/storage.legacyBucketReader" >/dev/null || true
fi

echo "==> [5/6] Creating / verifying GitHub CI/CD Deployer Service Account: ${DEPLOYER_SA}..."
if ! gcloud iam service-accounts describe "${DEPLOYER_SA}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${DEPLOYER_SA_NAME}" \
    --display-name="RavanaTek GitHub Actions CI/CD Deployer" \
    --project="${PROJECT_ID}"
fi

for ROLE in \
  roles/run.admin \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.admin \
  roles/firebasehosting.admin \
  roles/firebaserules.admin \
  roles/iam.serviceAccountUser \
  roles/serviceusage.serviceUsageConsumer \
  roles/logging.viewer \
  roles/storage.admin; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DEPLOYER_SA}" \
    --role="${ROLE}" \
    --condition=None >/dev/null
done

echo "==> [6/6] Setup complete!"
echo "Next steps in Cloud Shell:"
echo "  1. Create deployer JSON key:"
echo "     gcloud iam service-accounts keys create ravanatek-deployer-key.json --iam-account=${DEPLOYER_SA}"
echo "  2. Download via: cloudshell download ravanatek-deployer-key.json"
echo "  3. Add GitHub Secret GCP_SA_KEY with exact JSON content (then shred/rm local key)."
echo "  4. Add GitHub Variables: GCP_PROJECT_ID=${PROJECT_ID}, GCP_REGION=${REGION}, FIRESTORE_DATABASE_ID=${FIRESTORE_DB}, DEPLOY_FIRESTORE_RULES=true"
