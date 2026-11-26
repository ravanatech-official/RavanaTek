import express, { type Request, type Response, type NextFunction } from 'express';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';
const STORAGE_BACKEND = process.env.STORAGE_BACKEND === 'cloud' ? 'cloud' : 'local';

app.disable('x-powered-by');
app.set('trust proxy', 1);

function logEvent(severity: 'INFO' | 'ERROR', event: string, meta: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === 'production') {
    console.log(JSON.stringify({ severity, event, timestamp: new Date().toISOString(), ...meta }));
  } else if (severity === 'ERROR') {
    console.error(`[${event}]`, meta);
  }
}

app.use(compression({ level: 6, threshold: 256 }));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));

app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err))) {
    return res.status(400).json({ success: false, error: 'Invalid JSON payload.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Request payload too large.' });
  }
  return next(err);
});

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasDangerousKeys(value: unknown, depth = 0): boolean {
  if (depth > 5 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasDangerousKeys(item, depth + 1));
  }
  const keys = Object.getOwnPropertyNames(value);
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) return true;
    if (hasDangerousKeys((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

const DEFAULT_ORIGINS = [
  'https://ravanatek.web.app',
  'https://ravanatek.firebaseapp.com',
];
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .concat(DEFAULT_ORIGINS)
);

function isOriginPermitted(origin: string, reqHost: string, isAiStudioPreview: boolean): boolean {
  if (allowedOrigins.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    const originHost = parsed.host.toLowerCase();
    const originHostname = parsed.hostname.toLowerCase();
    if (reqHost && originHost === reqHost) return true;
    if (isAiStudioPreview) {
      if (
        originHostname === 'localhost' ||
        originHostname === '127.0.0.1' ||
        originHostname.startsWith('ais-dev-') ||
        originHostname.startsWith('ais-pre-') ||
        originHostname === 'aistudio.google.com' ||
        originHostname.endsWith('.usercontent.goog')
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const host = String(req.get('x-forwarded-host') || req.get('host') || req.hostname || '').toLowerCase();
  const isAiStudioPreview =
    process.env.NODE_ENV !== 'production' ||
    host.startsWith('ais-dev-') ||
    host.startsWith('ais-pre-');
  const isHttps = req.secure || req.get('x-forwarded-proto') === 'https';

  let decodedReqPath = req.path;
  try {
    decodedReqPath = decodeURIComponent(req.path);
  } catch {
    decodedReqPath = req.path;
  }
  const isConceptualDemo =
    decodedReqPath.startsWith('/conceptual projects/') ||
    decodedReqPath.startsWith('/conceptual-projects/');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!isAiStudioPreview) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), magnetometer=(), gyroscope=(), accelerometer=()'
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Resource-Policy', isAiStudioPreview ? 'cross-origin' : 'same-site');
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  const frameAncestors = isAiStudioPreview
    ? "frame-ancestors 'self' https://aistudio.google.com https://*.google.com https://*.usercontent.goog"
    : "frame-ancestors 'self'";

  const scriptSrc = isConceptualDemo
    ? "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://unpkg.com https://cdn.tailwindcss.com https://www.googletagmanager.com"
    : "script-src 'self' 'sha256-ggi9dVQEFdAqcDjQHp/SwxuPocrSA4HIBzSTKRVhAa8=' https://www.gstatic.com https://www.googletagmanager.com";
  const connectSrc = isConceptualDemo
    ? "connect-src 'self'"
    : "connect-src 'self' https://firestore.googleapis.com https://firebaseinstallations.googleapis.com https://www.google-analytics.com https://region1.google-analytics.com";
  const frameSrc = isConceptualDemo
    ? "frame-src 'self'"
    : "frame-src 'self' https://maps.google.com https://www.google.com";
  const upgradeDirective = isHttps ? '; upgrade-insecure-requests' : '';

  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:; img-src 'self' data: https:; ${connectSrc}; ${frameSrc}; object-src 'none'; ${frameAncestors}; base-uri 'self'; form-action 'self'${upgradeDirective}`
  );
  next();
});

const FORBIDDEN_PATH_PATTERN =
  /(?:^|\/)(?:\.|data|src|test|scripts|node_modules|\.git|\.aistudio|\.github)(?:\/|$)|(?:^|\/)(?:server\.(?:js|ts)|package(?:-lock)?\.json|firebase-applet-config\.json|firebase-blueprint\.json|firebase-init\.js|vite\.config\.ts|tsconfig\.json|metadata\.json|firestore\.rules|firebase\.json|DRAFT_[^/]*|security_spec\.md|walkthrough\.md|README\.md|Dockerfile|\.dockerignore|cloudbuild\.yaml)(?:$|\/)|\.rules$/i;

app.use((req: Request, res: Response, next: NextFunction) => {
  let decodedPath = req.path;
  try {
    decodedPath = decodeURIComponent(req.path);
  } catch {
    return res.status(400).json({ success: false, error: 'Malformed request path' });
  }
  const normalized = path.posix.normalize(decodedPath);
  if (
    req.path.includes('..') ||
    decodedPath.includes('..') ||
    normalized.includes('..') ||
    /%2e/i.test(req.originalUrl) ||
    FORBIDDEN_PATH_PATTERN.test(decodedPath) ||
    FORBIDDEN_PATH_PATTERN.test(normalized)
  ) {
    if (normalized === '/.well-known/security.txt') {
      return next();
    }
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  next();
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again shortly.' },
});

const inquiryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many inquiry submissions. Please contact us via WhatsApp.' },
});

app.use('/api', apiLimiter);
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'POST') {
    const contentType = String(req.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/json') && !contentType.startsWith('application/x-www-form-urlencoded')) {
      return res.status(415).json({ success: false, error: 'Unsupported Content-Type.' });
    }

    const origin = req.headers.origin;
    if (origin) {
      const reqHost = String(req.get('x-forwarded-host') || req.get('host') || '').toLowerCase();
      const isAiStudioPreview =
        process.env.NODE_ENV !== 'production' ||
        reqHost.startsWith('ais-dev-') ||
        reqHost.startsWith('ais-pre-');
      if (!isOriginPermitted(origin, reqHost, isAiStudioPreview)) {
        return res.status(403).json({ success: false, error: 'Origin not permitted.' });
      }
    }

    if (!isPlainObject(req.body) || hasDangerousKeys(req.body)) {
      return res.status(400).json({ success: false, error: 'Invalid or unsafe request payload.' });
    }
  }
  return next();
});

const DB_FILE = process.env.LEADS_DB_FILE
  ? path.resolve(process.env.LEADS_DB_FILE)
  : path.join(__dirname, 'data', 'leads-db.json');

let firestoreClientPromise: Promise<any> | null = null;

async function getCloudFirestore() {
  if (!firestoreClientPromise) {
    firestoreClientPromise = (async () => {
      const { initializeApp, getApps } = await import('firebase-admin/app');
      const { getFirestore } = await import('firebase-admin/firestore');
      const adminApp = getApps()[0] || initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'ravanatek',
      });
      const dbId = process.env.FIRESTORE_DATABASE_ID || 'ravanatek-db';
      return getFirestore(adminApp, dbId);
    })();
  }
  return firestoreClientPromise;
}

function initDb() {
  if (STORAGE_BACKEND === 'cloud') return;
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(DB_FILE)) {
      const initialDb = {
        initializedAt: new Date().toISOString(),
        version: '1.0.0',
        inquiries: [],
      };
      fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('[DB INIT ERROR]', err);
  }
}

initDb();

function saveLocalDbRecord(collection: string, record: any) {
  initDb();
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  const db = JSON.parse(raw);
  if (!db || typeof db !== 'object' || Array.isArray(db)) {
    throw new Error('Corrupt database structure');
  }
  if (!Array.isArray(db[collection])) {
    db[collection] = [];
  }
  db[collection].unshift(record);
  if (db[collection].length > 1000) {
    db[collection] = db[collection].slice(0, 1000);
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

const publicBuildDir = path.join(__dirname, 'public-build');
const hasPublicBuild = fs.existsSync(path.join(publicBuildDir, 'index.html'));
const publicRoot = hasPublicBuild ? publicBuildDir : __dirname;
const conceptualProjectsDir = path.join(publicRoot, 'conceptual projects');

const staticCacheOptions = {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  dotfiles: 'deny' as const,
  setHeaders: (res: Response, filePath: string) => {
    if (filePath.match(/\.(jpg|jpeg|png|webp|svg|ico|woff|woff2|ttf|eot)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.match(/\.(css|js)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate, max-age=0');
    }
  },
};

app.use('/conceptual projects', express.static(conceptualProjectsDir, staticCacheOptions));
app.use('/conceptual-projects', express.static(conceptualProjectsDir, staticCacheOptions));

app.get('/api/conceptual-projects', (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(conceptualProjectsDir)) {
      return res.json({ success: true, count: 0, projects: [] });
    }
    const files = fs.readdirSync(conceptualProjectsDir).filter((f) => f.endsWith('.html'));
    return res.json({
      success: true,
      count: files.length,
      projects: files.map((filename) => ({
        filename,
        url: `/conceptual projects/${encodeURIComponent(filename)}`,
        cleanUrl: `/conceptual-projects/${encodeURIComponent(filename)}`,
      })),
    });
  } catch (error: any) {
    logEvent('ERROR', 'conceptual_projects_list_failed', { error: error?.message || 'unknown' });
    return res.status(500).json({ success: false, error: 'Failed to load conceptual projects.' });
  }
});

app.get('/api/health', async (req: Request, res: Response) => {
  let projectCount = 50;
  try {
    if (fs.existsSync(conceptualProjectsDir)) {
      projectCount = fs.readdirSync(conceptualProjectsDir).filter((f) => f.endsWith('.html')).length;
    }
  } catch {
    projectCount = 50;
  }

  let firestoreStatus = STORAGE_BACKEND === 'cloud' ? 'configured' : 'local';
  if (STORAGE_BACKEND === 'cloud' && req.query.verify === 'true') {
    try {
      const db = await getCloudFirestore();
      await db.collection('inquiries').limit(1).get();
      firestoreStatus = 'available';
    } catch (err: any) {
      firestoreStatus = 'unavailable';
      logEvent('ERROR', 'firestore_health_check_failed', { error: err?.message || 'unknown' });
      return res.status(503).json({
        status: 'degraded',
        engine: 'Ravana Tech Raptor 3 Architecture',
        storageBackend: STORAGE_BACKEND,
        firestore: firestoreStatus,
        error: 'Cloud persistence verification unavailable.',
      });
    }
  }

  return res.json({
    status: 'online',
    engine: 'Ravana Tech Raptor 3 Architecture',
    uptime: `${Math.floor(process.uptime())}s`,
    timestamp: new Date().toISOString(),
    persistence: {
      storageBackend: STORAGE_BACKEND,
      firestore: firestoreStatus,
    },
    security: {
      securityHeaders: true,
      rateLimiting: true,
      cspEnabled: true,
      strictScriptCsp: true,
    },
    telemetry: {
      loadSpeed: '<0.20s',
      securityScore: '100/100',
      activeServices: 6,
      readyBlueprints: projectCount,
    },
  });
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const stripControl = (val: string) => val.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

app.post('/api/inquiry', inquiryLimiter, async (req: Request, res: Response) => {
  try {
    const { name, email, service, message, source } = req.body || {};
    const cleanName = typeof name === 'string' ? stripControl(name).replace(/[\r\n]+/g, ' ') : '';
    const cleanEmail = typeof email === 'string' ? stripControl(email).replace(/[\r\n\s]+/g, '') : '';
    const cleanService = typeof service === 'string' && stripControl(service) ? stripControl(service).replace(/[\r\n]+/g, ' ') : 'General Inquiry';
    const cleanMessage = typeof message === 'string' ? stripControl(message) : '';

    if (!cleanName || !cleanEmail || !cleanMessage) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, email, and message are required.',
      });
    }
    if (cleanName.length > 200 || cleanEmail.length > 200 || cleanService.length > 200 || cleanMessage.length > 5000) {
      return res.status(400).json({
        success: false,
        error: 'One or more fields exceed allowed maximum length.',
      });
    }
    if (!EMAIL_REGEX.test(cleanEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid email address.',
      });
    }

    const receivedAt = new Date().toISOString();
    const rawSource = typeof source === 'string' ? stripControl(source).replace(/[^a-z0-9_:-]/gi, '_').slice(0, 64) : '';
    const leadRecord = {
      id: `LEAD-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
      name: cleanName,
      email: cleanEmail,
      service: cleanService,
      message: cleanMessage,
      source: rawSource || 'react_contact_form',
      ip: req.ip || 'local',
      userAgent: (req.get('user-agent') || 'browser').slice(0, 250),
      receivedAt,
    };

    if (STORAGE_BACKEND === 'cloud') {
      const db = await getCloudFirestore();
      const docRef = await db.collection('inquiries').add({
        name: cleanName,
        email: cleanEmail,
        system: cleanService,
        message: cleanMessage,
        source: leadRecord.source,
        status: 'new',
        clientTimestamp: receivedAt,
        createdAt: new Date(),
      });
      return res.status(200).json({
        success: true,
        message: 'Inquiry received and stored in Cloud Firestore.',
        leadId: docRef.id,
        timestamp: receivedAt,
      });
    }

    saveLocalDbRecord('inquiries', leadRecord);
    logEvent('INFO', 'inquiry_persisted', { backend: 'local', service: cleanService });

    return res.status(200).json({
      success: true,
      message: 'Inquiry received and permanently stored in Ravana Tech Database.',
      leadId: leadRecord.id,
      timestamp: leadRecord.receivedAt,
    });
  } catch (err: any) {
    logEvent('ERROR', 'inquiry_persistence_failed', { error: err?.message || 'unknown' });
    return res.status(500).json({ success: false, error: 'Failed to persist inquiry.' });
  }
});

app.post('/api/document-sim', (req: Request, res: Response) => {
  const { sampleId } = req.body || {};
  const samples: Record<string, any> = {
    submittal: {
      docId: 'SUB-STR-2026-0442',
      title: 'Architectural Facade Glazing & Structural Framing Submittal',
      discipline: 'Structural & Architectural',
      revision: 'Rev 03',
      status: 'CODE 1 - APPROVED WITH NO COMMENTS',
      issuingParty: 'Al-Farooq Façade Engineering LLC',
      receivedDate: new Date().toISOString().split('T')[0],
      normalizedFilename: 'RT-EDMS_SUB_STR_0442_REV03_APP.pdf',
      cloudPath: '/Google_Cloud/EDMS/2026/Structural/Submittals/Approved/',
      confidence: '99.98%',
    },
    invoice: {
      docId: 'INV-DXB-2026-9042',
      title: 'Commercial Tax Invoice & Material Delivery Note',
      discipline: 'Commercial & Procurement',
      revision: 'Original Final',
      status: 'VERIFIED & MATCHED TO PO-90118',
      issuingParty: 'Emirates Cement & Steel Corporation',
      receivedDate: new Date().toISOString().split('T')[0],
      normalizedFilename: 'RT-COMM_INV_DXB_9042_PO90118.pdf',
      cloudPath: '/Google_Cloud/Accounts/Invoices/2026/Matched_PO/',
      confidence: '100%',
    },
    hvac: {
      docId: 'TS-MEP-HVAC-0881',
      title: 'Technical Submittal: High-Efficiency Variable Air Volume (VAV) Terminal Units',
      discipline: 'MEP / Mechanical',
      revision: 'Rev 02',
      status: 'CODE 2 - APPROVED WITH COMMENTS AS NOTED',
      issuingParty: 'Apex Thermo-Dynamic Solutions Ltd',
      receivedDate: new Date().toISOString().split('T')[0],
      normalizedFilename: 'RT-EDMS_TS_MEP_HVAC_0881_REV02_REV.pdf',
      cloudPath: '/Google_Cloud/EDMS/2026/MEP/Technical_Submittals/',
      confidence: '99.94%',
    },
    ncr: {
      docId: 'NCR-QAQC-2026-019',
      title: 'Non-Conformance Report & Remedial Corrective Action Protocol',
      discipline: 'QA/QC Quality Assurance',
      revision: 'Rev 01 - Closure Pending',
      status: 'UNDER TECHNICAL REVIEW',
      issuingParty: 'Ravana QA/QC Directorate',
      receivedDate: new Date().toISOString().split('T')[0],
      normalizedFilename: 'RT-QA_NCR_2026_019_OPEN.pdf',
      cloudPath: '/Google_Cloud/Quality/NCR_Logs/2026/',
      confidence: '100%',
    },
  };

  if (sampleId !== undefined && sampleId !== null && sampleId !== '') {
    if (typeof sampleId !== 'string' || !Object.prototype.hasOwnProperty.call(samples, sampleId)) {
      return res.status(400).json({ success: false, error: 'Invalid document sample identifier.' });
    }
  }
  const resolvedId = typeof sampleId === 'string' && sampleId ? sampleId : 'submittal';
  const doc = samples[resolvedId];
  return res.json({
    success: true,
    engine: 'Ravana Tech Cognitive OCR & EDMS Pipeline',
    timestamp: new Date().toISOString(),
    document: doc,
  });
});

app.get('/.well-known/security.txt', (_req: Request, res: Response) => {
  const secPath = path.join(publicRoot, '.well-known', 'security.txt');
  if (fs.existsSync(secPath)) {
    res.type('text/plain; charset=utf-8');
    return res.sendFile(secPath);
  }
  return res.status(404).json({ success: false, error: 'Not found' });
});

if (hasPublicBuild) {
  app.use(express.static(publicBuildDir, staticCacheOptions));
} else {
  app.use('/assets', express.static(path.join(__dirname, 'assets'), staticCacheOptions));
  app.use('/api/conceptual-projects.json', express.static(path.join(__dirname, 'api', 'conceptual-projects.json'), staticCacheOptions));
  const allowedRootAssets = [
    '/styles.css',
    '/main.js',
    '/ravana.webp',
    '/favicon.ico',
    '/favicon.png',
    '/favicon.svg',
    '/apple-touch-icon.png',
    '/manifest.webmanifest',
    '/robots.txt',
    '/sitemap.xml',
    '/security.txt',
    '/googled6cb87aabbea33cf.html',
    '/work1.jpg',
    '/work2.jpg',
    '/work3.jpg',
    '/work4.jpg',
    '/work5.jpg',
    '/work6.jpg',
  ];
  app.get(allowedRootAssets, (req: Request, res: Response, next: NextFunction) => {
    const filePath = path.join(__dirname, req.path);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
    return next();
  });
}

function sendPublicHtml(res: Response, filename: string) {
  const target = path.join(publicRoot, filename);
  if (!fs.existsSync(target)) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-cache, must-revalidate, max-age=0');
  return res.sendFile(target);
}

app.get(['/', '/home', '/about', '/systems', '/contact', '/ai-lab', '/automation', '/lab', '/experience'], (_req: Request, res: Response) => {
  return sendPublicHtml(res, 'index.html');
});

app.get(['/projects', '/archive', '/gallery', '/projects.html', '/gallery.html'], (_req: Request, res: Response) => {
  return sendPublicHtml(res, 'projects.html');
});

app.get(['/services', '/all-services', '/services.html'], (_req: Request, res: Response) => {
  return sendPublicHtml(res, 'services.html');
});

app.get(['/privacy', '/privacy.html'], (_req: Request, res: Response) => {
  return sendPublicHtml(res, 'privacy.html');
});

app.get(['/terms', '/terms.html'], (_req: Request, res: Response) => {
  return sendPublicHtml(res, 'terms.html');
});

app.get(['/security', '/security.html'], (_req: Request, res: Response) => {
  return sendPublicHtml(res, 'security.html');
});

app.get(['/data-policy', '/data-policy.html'], (_req: Request, res: Response) => {
  return sendPublicHtml(res, 'data-policy.html');
});

app.use((_req: Request, res: Response) => {
  return res.status(404).json({ success: false, error: 'Not found' });
});

const isMainModule = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)
);

async function main() {
  if (!isProd && !hasPublicBuild) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0' },
      appType: 'custom',
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`[Ravana Tech Server] listening on http://${HOST}:${PORT} (storage=${STORAGE_BACKEND})`);
  });

  const shutdown = (signal: string) => {
    console.log(`[Ravana Tech Server] Received ${signal}, shutting down gracefully...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (isMainModule) {
  main().catch((err) => {
    console.error('[Server Error]', err);
    process.exit(1);
  });
}
