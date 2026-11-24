import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  setDoc,
  deleteDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { configureDataAdapter, db } from "./db.js";

const firebaseConfig = {
  apiKey: "AIzaSyC5YqAdH94_yRLHC7YHl8jECLLfpWLwRNI",
  authDomain: "policytrack-c35df.firebaseapp.com",
  projectId: "policytrack-c35df",
  storageBucket: "policytrack-c35df.firebasestorage.app",
  messagingSenderId: "880009096174",
  appId: "1:880009096174:web:98e2d87ce556779e533cff",
  measurementId: "G-0W71V40JQP"
};

export function createFirestoreAdapter(firestore, firestoreSdk) {
  const { collection: colFn, getDocs: getDocsFn, doc: docFn, setDoc: setDocFn, deleteDoc: deleteDocFn, writeBatch: writeBatchFn } = firestoreSdk;
  if (![colFn, getDocsFn, docFn, setDocFn, deleteDocFn, writeBatchFn].every((method) => typeof method === "function")) {
    throw new Error("The Firestore SDK is missing a required data function.");
  }

  return {
    async list(collectionName) {
      const snapshot = await getDocsFn(colFn(firestore, collectionName));
      return snapshot.docs.map((item) => ({ ...item.data(), id: item.id }));
    },
    async save(collectionName, record) {
      await setDocFn(docFn(firestore, collectionName, record.id), record);
      return record;
    },
    async remove(collectionName, id) {
      await deleteDocFn(docFn(firestore, collectionName, id));
    },
    async replaceWorkspace(workspace) {
      const snapshots = await Promise.all(db.collections.map((name) => getDocsFn(colFn(firestore, name))));
      const existingByCollection = Object.fromEntries(db.collections.map((name, index) => [name, snapshots[index].docs]));
      const writeCount = db.collections.reduce((total, name) => {
        const importedIds = new Set(workspace[name].map((record) => record.id));
        const removals = existingByCollection[name].filter((record) => !importedIds.has(record.id)).length;
        return total + workspace[name].length + removals;
      }, 0);
      if (writeCount > 500) {
        throw new Error("This backup exceeds Firestore's 500-write batch limit. Reduce the record count before restoring it to Firestore.");
      }
      if (writeCount === 0) return;
      const batch = writeBatchFn(firestore);
      for (const collectionName of db.collections) {
        const importedIds = new Set(workspace[collectionName].map((record) => record.id));
        for (const existingRecord of existingByCollection[collectionName]) {
          if (!importedIds.has(existingRecord.id)) batch.delete(docFn(firestore, collectionName, existingRecord.id));
        }
        for (const record of workspace[collectionName]) batch.set(docFn(firestore, collectionName, record.id), record);
      }
      await batch.commit();
    }
  };
}

export function connectFirestore(firestore, firestoreSdk) {
  configureDataAdapter(createFirestoreAdapter(firestore, firestoreSdk));
  return db;
}

const firebaseApp = initializeApp(firebaseConfig);
const firestoreDb = getFirestore(firebaseApp);

connectFirestore(firestoreDb, {
  collection,
  getDocs,
  doc,
  setDoc,
  deleteDoc,
  writeBatch
});

export { firebaseApp, firestoreDb, db };