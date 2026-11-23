import express from 'express';
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
const STORAGE_BACKEND = process.env.STORAGE_BACKEND === 'cloud' ? 'cloud' : 'local';

app.disable('x-powered-by');
app.set('trust proxy', 1);

function logEvent(severity, event, meta = {}) {
  if (process.env.NODE_ENV === 'production') {
    console.log(JSON.stringify({ severity, event, timestamp: new Date().toISOString(), ...meta }));
  } else if (severity === 'ERROR') {
    console.error(`[${event}]`, meta);
  }
}

// Ultra-fast Gzip compression
app.use(compression({ level: 6, threshold: 256, memLevel: 8 }));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));

// Allowed CORS origins
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

app.use((req, res, next) => {
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

// Silicon Valley Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Timing-Allow-Origin', '*');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.gstatic.com https://unpkg.com https://cdn.tailwindcss.com https://www.googletagmanager.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:; img-src 'self' data: https:; connect-src 'self' https://firestore.googleapis.com https://firebaseinstallations.googleapis.com https://www.google-analytics.com https://region1.google-analytics.com; frame-src 'self' https://maps.google.com https://www.google.com; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
  );
  next();
});

// Explicit Blocklist for Private / Source / Config Paths (even via aliases or encoded traversal)
const FORBIDDEN_PATH_PATTERN =
  /(?:^|\/)(?:\.|data|src|test|scripts|node_modules|\.git|\.aistudio)(?:\/|$)|(?:^|\/)(?:server\.(?:js|ts)|package(?:-lock)?\.json|firebase-applet-config\.json|firebase-init\.js|vite\.config\.ts|tsconfig\.json|metadata\.json|firestore\.rules|firebase\.json|Dockerfile|\.dockerignore|cloudbuild\.yaml)(?:$|\/)/i;

app.use((req, res, next) => {
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
    // Allow .well-known/security.txt specifically
    if (normalized === '/.well-known/security.txt') {
      return next();
    }
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  next();
});

// Rate Limiters
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

// ==================== PERSISTENCE LAYER (LOCAL JSON + CLOUD FIRESTORE) ====================
const DB_FILE = process.env.LEADS_DB_FILE
  ? path.resolve(process.env.LEADS_DB_FILE)
  : path.join(__dirname, 'data', 'leads-db.json');

let firestoreClientPromise = null;

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

function saveLocalDbRecord(collection, record) {
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

// ==================== STATIC PUBLIC DIRECTORY RESOLUTION ====================
const publicBuildDir = path.join(__dirname, 'public-build');
const hasPublicBuild = fs.existsSync(path.join(publicBuildDir, 'index.html'));
const publicRoot = hasPublicBuild ? publicBuildDir : __dirname;
const conceptualProjectsDir = path.join(publicRoot, 'conceptual projects');

const staticCacheOptions = {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  dotfiles: 'deny',
  setHeaders: (res, filePath) => {
    if (filePath.match(/\.(jpg|jpeg|png|webp|svg|ico|woff|woff2|ttf|eot)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.match(/\.(css|js)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate, max-age=0');
    }
  },
};

// ==================== REST API ENDPOINTS ====================
app.get('/api/conceptual-projects', (_req, res) => {
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
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', async (req, res) => {
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
    } catch (err) {
      firestoreStatus = 'unavailable';
      return res.status(503).json({
        status: 'degraded',
        engine: 'Ravana Tech Raptor 3 Architecture',
        storageBackend: STORAGE_BACKEND,
        firestore: firestoreStatus,
        error: err.message,
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
const stripControl = (val) => val.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

app.post('/api/inquiry', inquiryLimiter, async (req, res) => {
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
    const leadRecord = {
      id: `LEAD-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
      name: cleanName,
      email: cleanEmail,
      service: cleanService,
      message: cleanMessage,
      source: typeof source === 'string' && source.trim() ? source.trim().slice(0, 100) : 'website_contact_form',
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
  } catch (err) {
    logEvent('ERROR', 'inquiry_persistence_failed', { error: err?.message || 'unknown' });
    return res.status(500).json({ success: false, error: 'Failed to persist inquiry.' });
  }
});

app.post('/api/document-sim', (req, res) => {
  const { sampleId } = req.body || {};
  const samples = {
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

  const doc = samples[sampleId] || samples.submittal;
  return res.json({
    success: true,
    engine: 'Ravana Tech Cognitive OCR & EDMS Pipeline',
    timestamp: new Date().toISOString(),
    document: doc,
  });
});

// ==================== STATIC ALLOWLISTED SERVING ====================
app.use('/conceptual projects', express.static(conceptualProjectsDir, staticCacheOptions));
app.use('/conceptual-projects', express.static(conceptualProjectsDir, staticCacheOptions));

app.get('/.well-known/security.txt', (_req, res) => {
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
  // Local dev fallback before `npm run build`: expose ONLY explicit public assets, never root
  app.get('/assets/img/ravana_tech_logo_1792581937150.jpg', (_req, res) => {
    const logoPath = path.join(__dirname, 'src', 'assets', 'images', 'ravana_tech_logo_1792581937150.jpg');
    return fs.existsSync(logoPath) ? res.sendFile(logoPath) : res.status(404).end();
  });
  app.get('/assets/img/ravana_tech_logo_opt.webp', (_req, res) => {
    const logoPath = path.join(__dirname, 'src', 'assets', 'images', 'ravana_tech_logo_opt.webp');
    return fs.existsSync(logoPath) ? res.sendFile(logoPath) : res.status(404).end();
  });
  app.use('/assets', express.static(path.join(__dirname, 'assets'), staticCacheOptions));
  app.use('/api/conceptual-projects.json', express.static(path.join(__dirname, 'api', 'conceptual-projects.json'), staticCacheOptions));
  const allowedRootAssets = new Set([
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
  ]);
  app.get(Array.from(allowedRootAssets), (req, res, next) => {
    const filePath = path.join(__dirname, req.path);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
    return next();
  });
}

function sendPublicHtml(res, filename) {
  const target = path.join(publicRoot, filename);
  if (!fs.existsSync(target)) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-cache, must-revalidate, max-age=0');
  return res.sendFile(target);
}

app.get(['/', '/home', '/about', '/systems', '/contact', '/ai-lab', '/automation', '/lab', '/experience'], (_req, res) => {
  return sendPublicHtml(res, 'index.html');
});

app.get(['/projects', '/archive', '/gallery', '/projects.html', '/gallery.html'], (_req, res) => {
  return sendPublicHtml(res, 'projects.html');
});

app.get(['/services', '/all-services', '/services.html'], (_req, res) => {
  return sendPublicHtml(res, 'services.html');
});

app.get(['/privacy', '/privacy.html'], (_req, res) => {
  return sendPublicHtml(res, 'privacy.html');
});

app.get(['/terms', '/terms.html'], (_req, res) => {
  return sendPublicHtml(res, 'terms.html');
});

app.get(['/security', '/security.html'], (_req, res) => {
  return sendPublicHtml(res, 'security.html');
});

app.get(['/data-policy', '/data-policy.html'], (_req, res) => {
  return sendPublicHtml(res, 'data-policy.html');
});

// Explicit 404 JSON response for unknown paths (no soft-404 index fallback)
app.use((_req, res) => {
  return res.status(404).json({ success: false, error: 'Not found' });
});

const isMainModule = Boolean(
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)
);

if (isMainModule) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`[Ravana Tech Server] listening on http://${HOST}:${PORT} (storage=${STORAGE_BACKEND})`);
  });

  const shutdown = (signal) => {
    console.log(`[Ravana Tech Server] Received ${signal}, shutting down gracefully...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
