// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported as isAnalyticsSupported } from "firebase/analytics";
import { getFirestore, collection, addDoc, serverTimestamp } from "firebase/firestore";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
export const firebaseConfig = {
  apiKey: "AIzaSyC7WWfls56qBV_9jmaAx6BtLh_BkL6GI1U",
  authDomain: "ravanatek.firebaseapp.com",
  projectId: "ravanatek",
  storageBucket: "ravanatek.firebasestorage.app",
  messagingSenderId: "939944415589",
  appId: "1:939944415589:web:fb51e72dacecb6fe36918c",
  measurementId: "G-9PK7NSWBJ9"
};

const PRODUCTION_FIREBASE_HOSTS = new Set(["ravanatek.web.app", "ravanatek.firebaseapp.com"]);

if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const code = reason && reason.code ? String(reason.code) : "";
    const msg = reason && reason.message ? String(reason.message) : String(reason || "");
    if (code.startsWith("installations/") || msg.includes("installations/request-failed")) {
      event.preventDefault();
      console.warn("[Firebase Analytics] Installations skipped (API key restricted or unavailable for this origin):", msg);
    }
  });
}

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
export let analytics = null;
if (typeof window !== "undefined" && PRODUCTION_FIREBASE_HOSTS.has(window.location.hostname)) {
  isAnalyticsSupported()
    .then((supported) => {
      if (supported) {
        analytics = getAnalytics(app);
        window.firebaseAnalytics = analytics;
      }
    })
    .catch((err) => {
      console.info("[Firebase Analytics] Analytics initialized or deferred:", err);
    });
}

export let db = null;
try {
  db = getFirestore(app, "ravanatek-db");
} catch (err) {
  console.info("[Firestore] Firestore initialized or deferred:", err);
}

// Global persistence helper
export async function saveInquiry(inquiryData) {
  if (!db) return { success: false, reason: "firestore_not_initialized" };
  try {
    const docRef = await addDoc(collection(db, "inquiries"), {
      name: inquiryData.name,
      email: inquiryData.email,
      system: inquiryData.system,
      message: inquiryData.message,
      createdAt: serverTimestamp(),
      clientTimestamp: new Date().toISOString(),
      source: "website_command_console",
      status: "new"
    });
    return { success: true, id: docRef.id };
  } catch (err) {
    console.warn("[Firestore] saveInquiry error:", err);
    return { success: false, error: err };
  }
}

// Expose globally on window for client convenience
if (typeof window !== "undefined") {
  window.firebaseApp = app;
  window.firebaseAnalytics = analytics;
  window.firebaseDb = db;
  window.saveInquiryToFirestore = saveInquiry;
  console.log("[RAVANA TECH] Firebase & Firestore initialized successfully // Project: ravanatek");
}
