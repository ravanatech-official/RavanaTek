// Lazy-initialized Firebase & Firestore module (zero inline script execution required)
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported as isAnalyticsSupported } from "firebase/analytics";
import { getFirestore, collection, addDoc, serverTimestamp } from "firebase/firestore";

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
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

let appInstance = null;
let firestoreInstance = null;
export let analytics = null;

function stripControlChars(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function handleFirestoreError(err, operationType, path) {
  const errInfo = {
    error: err instanceof Error ? err.message : String(err),
    code: err && typeof err === "object" && "code" in err ? String(err.code) : "unknown",
    operationType,
    path
  };
  console.warn("[RAVANA TECH] Firestore operation context:", JSON.stringify(errInfo));
  return errInfo;
}

if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const code = reason && reason.code ? String(reason.code) : "";
    const msg = reason && reason.message ? String(reason.message) : String(reason || "");
    if (code.startsWith("installations/") || msg.includes("installations/request-failed")) {
      event.preventDefault();
      console.warn("[RAVANA TECH] Firebase Analytics/Installations skipped for non-production origin.");
    }
  });
}

export function getFirestoreInstance() {
  if (!firestoreInstance) {
    appInstance = initializeApp(firebaseConfig);
    if (typeof window !== "undefined" && PRODUCTION_FIREBASE_HOSTS.has(window.location.hostname)) {
      isAnalyticsSupported()
        .then((supported) => {
          if (supported) {
            analytics = getAnalytics(appInstance);
            window.firebaseAnalytics = analytics;
          }
        })
        .catch(() => {});
    }
    firestoreInstance = getFirestore(appInstance, "ravanatek-db");
    if (typeof window !== "undefined") {
      window.firebaseApp = appInstance;
      window.firebaseDb = firestoreInstance;
    }
  }
  return firestoreInstance;
}

// Pre-warm Firestore when contact section enters view to avoid initial submission latency
if (typeof document !== "undefined" && typeof window !== "undefined") {
  const prewarm = () => {
    const contactSection = document.getElementById("contact");
    if (contactSection && "IntersectionObserver" in window) {
      const contactObserver = new IntersectionObserver((entries) => {
        if (entries[0] && entries[0].isIntersecting) {
          try {
            getFirestoreInstance();
          } catch (err) {
            handleFirestoreError(err, "init", "inquiries");
          }
          contactObserver.disconnect();
        }
      }, { threshold: 0.1 });
      contactObserver.observe(contactSection);
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", prewarm, { once: true });
  } else {
    prewarm();
  }
}

export async function saveInquiry(inquiryData) {
  const cleanName = stripControlChars(inquiryData?.name).replace(/[\r\n]+/g, " ").slice(0, 200);
  const cleanEmail = stripControlChars(inquiryData?.email).replace(/[\r\n\s]+/g, "").slice(0, 200);
  const cleanSystem = stripControlChars(inquiryData?.system).replace(/[\r\n]+/g, " ").slice(0, 200);
  const cleanMessage = stripControlChars(inquiryData?.message).slice(0, 5000);

  if (!cleanName || !cleanEmail || !cleanMessage || !EMAIL_PATTERN.test(cleanEmail)) {
    return { success: false, reason: "validation_failed" };
  }

  try {
    const db = getFirestoreInstance();
    if (!db) return { success: false, reason: "firestore_not_initialized" };

    const payload = {
      name: cleanName,
      email: cleanEmail,
      message: cleanMessage,
      createdAt: serverTimestamp(),
      clientTimestamp: new Date().toISOString(),
      source: "website_command_console",
      status: "new"
    };
    if (cleanSystem) {
      payload.system = cleanSystem;
    }

    const docRef = await addDoc(collection(db, "inquiries"), payload);
    return { success: true, id: docRef.id };
  } catch (err) {
    handleFirestoreError(err, "create", "inquiries");
    return { success: false, error: err };
  }
}

if (typeof window !== "undefined") {
  window.saveInquiryToFirestore = saveInquiry;
}
