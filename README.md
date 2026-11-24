# PolicyTrack

PolicyTrack is a responsive, single-agent insurance workspace. It opens directly to Customers and saves records in the current browser using local storage.

## Run locally

Serve this folder over localhost so the service worker can cache the app shell:

```sh
python -m http.server 8000 --directory outputs
```

Open `http://localhost:8000` in a browser. The app can also be hosted as static files on an HTTPS site.

## Data and Firebase

The interface reads and writes through the small adapter in `db.js`. The default adapter stores `clients`, `familyMembers`, `policies`, and `followUps` in local storage. `firebase-config.js` exports a Firestore adapter with the same `list`, `save`, and `remove` operations.

Use Export JSON to download the four collections. Import JSON validates the exact PolicyTrack model fields, record types, IDs, dates, and client references, then asks for confirmation before replacing the current workspace. Firestore restores use one atomic batch and are limited to 500 writes.

To connect Firebase, add the Firebase modular SDK to the project, fill in `firebaseConfig` in `firebase-config.js`, initialize Firebase and Firestore, then call `connectFirestore(firestore, firestoreSdk)` before `startApp()` loads the workspace in `app.js`. The adapter provides `list`, `save`, `remove`, and `replaceWorkspace`; the UI continues using `db`, so its screens do not need to change. Configure the Firestore security rules for the intended deployment before storing customer data there.

## App files

- `index.html` — app shell and dialogs
- `styles.css` — responsive white, emerald, and gold theme
- `app.js` — screens, date calculations, forms, and interactions
- `db.js` — local storage adapter and shared data interface
- `firebase-config.js` — Firestore adapter and project configuration
- `manifest.json`, `sw.js`, `icon.svg` — install and offline support
