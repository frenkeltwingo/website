/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const axios = require("axios");

admin.initializeApp();

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

// --- Konfiguration ---
const APPS_SCRIPT_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbwCHumHfFd19tozJbf5KTLeftEaL5XoAPOv07Vv2Lvs8Wy-zVH2TaxLfsy1S9SoWLw/exec";
const GOOGLE_CALENDAR_ID = "northdrive25@gmail.com";
const INTERVIEW_DURATION_HOURS = 1; // Dauer des Interviews in Stunden
const SERVICE_ACCOUNT_KEY_FILENAME = "./northdrive-fb0d6-e34ab777536d.json"; // Relativer Pfad zur Schlüsseldatei im functions-Ordner

let auth;
try {
  const serviceAccountCredentials = require(SERVICE_ACCOUNT_KEY_FILENAME);
  auth = new google.auth.GoogleAuth({
    credentials: serviceAccountCredentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
} catch (error) {
  console.error("FEHLER: Service Account Schlüsseldatei konnte nicht geladen werden:", SERVICE_ACCOUNT_KEY_FILENAME, error);
  console.error("Stellen Sie sicher, dass die Datei im functions-Ordner liegt und der Pfad korrekt ist.");
  // Verhindere, dass die Function bereitgestellt wird oder initialisiert wird, wenn der Schlüssel fehlt.
  // Firebase wird beim Deployment-Versuch wahrscheinlich sowieso fehlschlagen, aber dies gibt eine frühere Meldung.
  throw new Error("Service Account Schlüssel konnte nicht geladen werden. Function kann nicht initialisiert werden.");
}

const calendar = google.calendar({ version: "v3", auth });

exports.onNewBooking = functions.region("europe-west3") // Angepasst an Firestore-Region eur3 (Frankfurt)
  .firestore.document("bookedInterviewSlots/{slotId}")
  .onCreate(async (snap, context) => {
    const bookingData = snap.data();
    const slotId = context.params.slotId;
    functions.logger.log(`Neue Buchung empfangen für Slot ID: ${slotId}`, bookingData);

    if (!bookingData || !bookingData.applicantInfo || !bookingData.slotDateTime) {
      functions.logger.error("Fehlende Daten in der Buchung:", bookingData);
      return null;
    }

    const applicantInfo = bookingData.applicantInfo;
    // Firestore Timestamps kommen als Firebase Timestamp-Objekte an, .toDate() konvertiert sie zu JS Date-Objekten
    const slotDateTime = bookingData.slotDateTime.toDate(); 

    // 1. Google Kalender-Event erstellen
    try {
      const eventEndTime = new Date(slotDateTime.getTime() + INTERVIEW_DURATION_HOURS * 60 * 60 * 1000);

      const event = {
        summary: `Bewerbungsgespräch: ${applicantInfo.name || "Unbekannt"}`,
        description: `Bewerberdetails:\nE-Mail: ${applicantInfo.email || "n/a"}\nTelefon: ${applicantInfo.phone || "n/a"}\nStadt: ${applicantInfo.city || "n/a"}\nFührerschein bestätigt: ${bookingData.driversLicenseConfirmed ? "Ja" : "Nein"}\nAnschreiben: ${applicantInfo.coverletter || "n/a"}\nGebucht am Firestore Timestamp: ${bookingData.bookedAt ? bookingData.bookedAt.toDate().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : "n/a"}`,
        start: {
          dateTime: slotDateTime.toISOString(),
          timeZone: "Europe/Berlin", 
        },
        end: {
          dateTime: eventEndTime.toISOString(),
          timeZone: "Europe/Berlin", 
        },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "email", minutes: 24 * 60 },
            { method: "popup", minutes: 60 },
          ],
        },
      };

      const createdEvent = await calendar.events.insert({
        calendarId: GOOGLE_CALENDAR_ID,
        resource: event,
      });
      functions.logger.log("Google Kalender Event erstellt:", createdEvent.data.htmlLink);
    } catch (error) {
      functions.logger.error("Fehler beim Erstellen des Google Kalender Events:", error.response ? error.response.data : error.message, error.stack);
    }

    // 2. Daten an Google Apps Script senden für Google Sheets Eintrag
    try {
      const year = slotDateTime.getFullYear();
      const month = (slotDateTime.getMonth() + 1).toString().padStart(2, "0");
      const day = slotDateTime.getDate().toString().padStart(2, "0");
      const hours = slotDateTime.getHours().toString().padStart(2, "0");
      const minutes = slotDateTime.getMinutes().toString().padStart(2, "0");

      const dateKey = `${year}-${month}-${day}`;
      const timeArray = [`${hours}:${minutes}`];
      const detailedAvailabilityString = JSON.stringify({ [dateKey]: timeArray });

      const paramsForAppsScript = {
        name: applicantInfo.name || "",
        email: applicantInfo.email || "",
        phone: applicantInfo.phone || "",
        city: applicantInfo.city || "",
        coverletter: applicantInfo.coverletter || "",
        driversLicenseB: bookingData.driversLicenseConfirmed ? "bestaetigt" : "Nein",
        detailedAvailability: detailedAvailabilityString,
        // Das Feld 'availability_summary' wird im Apps Script aus 'detailedAvailability' generiert
        // Der 'timestamp' für die Google Sheet Zeile wird vom Apps Script selbst hinzugefügt
      };

      functions.logger.log("Sende Daten an Apps Script:", paramsForAppsScript);

      const response = await axios.post(APPS_SCRIPT_WEB_APP_URL, paramsForAppsScript, {
        headers: { "Content-Type": "application/json" },
      });

      functions.logger.log("Antwort vom Apps Script:", response.status, response.data);
    } catch (error) {
      functions.logger.error("Fehler beim Senden der Daten an das Apps Script:", error.response ? error.response.data : error.message, error.stack);
    }
    return null;
  });
