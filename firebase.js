require('dotenv').config();
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

// Initialize Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  
  const db = admin.firestore(); // Firestore instance
  
module.exports = { db };