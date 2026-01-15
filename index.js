import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { CloudTasksClient } from '@google-cloud/tasks';
import admin from 'firebase-admin';
import twilio from 'twilio';

// Configuration from environment variables
const config = {
  twilioSid: process.env.TWILIO_SID,
  twilioToken: process.env.TWILIO_TOKEN,
  twilioNumber: process.env.TWILIO_NUMBER,
  recipientNumbers: (process.env.RECIPIENT_NUMBERS || '').split(',').filter(Boolean),
  parkIds: (process.env.PARK_IDS || '').split(',').filter(Boolean),
  watchedRides: (process.env.WATCHED_RIDES || '').split(',').filter(Boolean),
  port: parseInt(process.env.PORT || '8080', 10),
  // Dynamic scheduling config
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.CLOUD_TASKS_LOCATION || 'us-central1',
  queueName: process.env.CLOUD_TASKS_QUEUE || 'ride-watch-queue',
  serviceUrl: process.env.SERVICE_URL,
  // Intervals in seconds
  normalIntervalSec: parseInt(process.env.NORMAL_INTERVAL_SEC || '300', 10),
  alertIntervalSec: parseInt(process.env.ALERT_INTERVAL_SEC || '60', 10),
  // Feature flags
  dynamicScheduling: process.env.DYNAMIC_SCHEDULING === 'true',
  enableSms: process.env.ENABLE_SMS !== 'false', // Default true
  enablePush: process.env.ENABLE_PUSH !== 'false', // Default true
};

// Initialize Firebase Admin (uses Application Default Credentials in Cloud Run)
let firebaseInitialized = false;
try {
  admin.initializeApp({
    projectId: config.projectId,
  });
  firebaseInitialized = true;
  console.log('Firebase Admin initialized');
} catch (error) {
  console.warn('Firebase Admin initialization failed:', error.message);
}

// Initialize Firestore
const firestore = new Firestore();
const statusCollection = firestore.collection('ride-status');
const devicesCollection = firestore.collection('devices');

// Initialize Cloud Tasks client
const tasksClient = new CloudTasksClient();

// Initialize Twilio client
const twilioClient = config.twilioSid && config.twilioToken
  ? twilio(config.twilioSid, config.twilioToken)
  : null;

// ThemeParks Wiki API base URL
const API_BASE = 'https://api.themeparks.wiki/v1';

// Non-operating statuses that trigger faster polling
const DOWN_STATUSES = new Set(['DOWN', 'REFURBISHMENT', 'CLOSED']);

/**
 * Fetch live attraction data for a park
 */
async function fetchParkLiveData(parkId) {
  const url = `${API_BASE}/entity/${parkId}/live`;
  console.log(`Fetching live data for park: ${parkId}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch park data: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data;
}

/**
 * Get previous status from Firestore
 */
async function getPreviousStatus(rideId) {
  const doc = await statusCollection.doc(rideId).get();
  return doc.exists ? doc.data() : null;
}

/**
 * Save current status to Firestore
 */
async function saveStatus(rideId, status, rideName) {
  await statusCollection.doc(rideId).set({
    status,
    rideName,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Get all registered device tokens from Firestore
 */
async function getDeviceTokens() {
  const snapshot = await devicesCollection.where('active', '==', true).get();
  return snapshot.docs.map(doc => ({
    token: doc.id,
    ...doc.data(),
  }));
}

/**
 * Register a device token
 */
async function registerDevice(token, metadata = {}) {
  await devicesCollection.doc(token).set({
    active: true,
    registeredAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    platform: metadata.platform || 'ios',
    ...metadata,
  }, { merge: true });
}

/**
 * Unregister a device token
 */
async function unregisterDevice(token) {
  await devicesCollection.doc(token).update({
    active: false,
    unregisteredAt: new Date().toISOString(),
  });
}

/**
 * Mark a device token as invalid (for cleanup)
 */
async function markTokenInvalid(token) {
  await devicesCollection.doc(token).update({
    active: false,
    invalid: true,
    invalidatedAt: new Date().toISOString(),
  });
}

/**
 * Send push notification via Firebase Cloud Messaging
 */
async function sendPushNotification(title, body, data = {}) {
  if (!firebaseInitialized) {
    console.warn('Firebase not initialized, skipping push notification');
    return { sent: 0, failed: 0 };
  }

  if (!config.enablePush) {
    console.log('Push notifications disabled');
    return { sent: 0, failed: 0 };
  }

  const devices = await getDeviceTokens();
  if (devices.length === 0) {
    console.log('No registered devices for push notifications');
    return { sent: 0, failed: 0 };
  }

  console.log(`Sending push notification to ${devices.length} device(s)`);

  let sent = 0;
  let failed = 0;

  // Send to each device individually to handle errors per-device
  for (const device of devices) {
    try {
      const message = {
        token: device.token,
        notification: {
          title,
          body,
        },
        data: {
          ...data,
          timestamp: new Date().toISOString(),
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      await admin.messaging().send(message);
      sent++;
      console.log(`Push sent to device ${device.token.slice(0, 20)}...`);
    } catch (error) {
      failed++;
      console.error(`Failed to send push to ${device.token.slice(0, 20)}...:`, error.message);

      // Mark invalid tokens for cleanup
      if (
        error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered'
      ) {
        console.log(`Marking invalid token: ${device.token.slice(0, 20)}...`);
        await markTokenInvalid(device.token);
      }
    }
  }

  return { sent, failed };
}

/**
 * Send SMS notification via Twilio
 */
async function sendSmsNotification(message) {
  if (!twilioClient) {
    console.warn('Twilio not configured, skipping SMS notification');
    return { sent: 0, failed: 0 };
  }

  if (!config.enableSms) {
    console.log('SMS notifications disabled');
    return { sent: 0, failed: 0 };
  }

  if (config.recipientNumbers.length === 0) {
    console.warn('No recipient numbers configured');
    return { sent: 0, failed: 0 };
  }

  console.log(`Sending SMS to ${config.recipientNumbers.length} recipient(s)`);

  let sent = 0;
  let failed = 0;

  const sendPromises = config.recipientNumbers.map(async (to) => {
    try {
      await twilioClient.messages.create({
        body: message,
        from: config.twilioNumber,
        to: to.trim(),
      });
      sent++;
      console.log(`SMS sent to ${to}`);
    } catch (error) {
      failed++;
      console.error(`Failed to send SMS to ${to}:`, error.message);
    }
  });

  await Promise.all(sendPromises);
  return { sent, failed };
}

/**
 * Send notification via all configured channels (SMS + Push)
 */
async function sendNotification(title, body, data = {}) {
  const results = {
    sms: { sent: 0, failed: 0 },
    push: { sent: 0, failed: 0 },
  };

  // Send SMS (body only, no title)
  results.sms = await sendSmsNotification(body);

  // Send push notification
  results.push = await sendPushNotification(title, body, data);

  return results;
}

/**
 * Check if a ride should be monitored based on watched rides config
 */
function shouldMonitorRide(rideName) {
  if (config.watchedRides.length === 0) {
    return true;
  }
  return config.watchedRides.some(watched =>
    rideName.toLowerCase().includes(watched.toLowerCase().trim())
  );
}

/**
 * Check if a status is considered "down"
 */
function isDownStatus(status) {
  return DOWN_STATUSES.has(status);
}

/**
 * Format status change message
 */
function formatStatusMessage(rideName, oldStatus, newStatus) {
  return `🎢 ${rideName}: ${oldStatus || 'Unknown'} → ${newStatus}`;
}

/**
 * Get notification title based on status change
 */
function getNotificationTitle(newStatus) {
  if (newStatus === 'OPERATING') {
    return 'Ride Back Up! 🎉';
  } else if (newStatus === 'DOWN') {
    return 'Ride Down ⚠️';
  } else if (newStatus === 'CLOSED') {
    return 'Ride Closed';
  } else if (newStatus === 'REFURBISHMENT') {
    return 'Ride Under Refurbishment';
  }
  return 'Ride Status Changed';
}

/**
 * Schedule the next check using Cloud Tasks
 */
async function scheduleNextCheck(delaySeconds) {
  if (!config.dynamicScheduling) {
    console.log('Dynamic scheduling disabled, skipping task creation');
    return;
  }

  if (!config.projectId || !config.serviceUrl) {
    console.warn('Missing PROJECT_ID or SERVICE_URL, cannot schedule next check');
    return;
  }

  const queuePath = tasksClient.queuePath(
    config.projectId,
    config.location,
    config.queueName
  );

  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: `${config.serviceUrl}/check`,
      headers: {
        'Content-Type': 'application/json',
      },
    },
    scheduleTime: {
      seconds: Math.floor(Date.now() / 1000) + delaySeconds,
    },
  };

  try {
    const [response] = await tasksClient.createTask({ parent: queuePath, task });
    console.log(`Scheduled next check in ${delaySeconds}s: ${response.name}`);
  } catch (error) {
    console.error('Failed to schedule next check:', error.message);
  }
}

/**
 * Process attractions and check for status changes
 */
async function checkStatusChanges() {
  if (config.parkIds.length === 0) {
    console.warn('No park IDs configured');
    return { checked: 0, changes: 0, ridesDown: 0, notifications: null };
  }

  let totalChecked = 0;
  let totalChanges = 0;
  let ridesDown = 0;
  const statusChanges = [];

  for (const parkId of config.parkIds) {
    try {
      const liveData = await fetchParkLiveData(parkId);

      if (!liveData.liveData || !Array.isArray(liveData.liveData)) {
        console.warn(`No live data array for park ${parkId}`);
        continue;
      }

      const attractions = liveData.liveData.filter(
        entity => entity.entityType === 'ATTRACTION'
      );

      console.log(`Found ${attractions.length} attractions in park ${parkId}`);

      for (const attraction of attractions) {
        const rideId = attraction.id;
        const rideName = attraction.name;
        const currentStatus = attraction.status || 'UNKNOWN';

        if (!shouldMonitorRide(rideName)) {
          continue;
        }

        totalChecked++;

        if (isDownStatus(currentStatus)) {
          ridesDown++;
        }

        const previousData = await getPreviousStatus(rideId);
        const previousStatus = previousData?.status;

        if (previousStatus && previousStatus !== currentStatus) {
          console.log(`Status change detected: ${rideName} (${previousStatus} → ${currentStatus})`);
          totalChanges++;
          statusChanges.push({
            rideId,
            rideName,
            oldStatus: previousStatus,
            newStatus: currentStatus,
          });
        }

        await saveStatus(rideId, currentStatus, rideName);
      }
    } catch (error) {
      console.error(`Error processing park ${parkId}:`, error.message);
    }
  }

  // Send notifications for all status changes
  let notificationResults = null;
  if (statusChanges.length > 0) {
    if (statusChanges.length <= 3) {
      // Send individual notifications for small number of changes
      for (const change of statusChanges) {
        const title = getNotificationTitle(change.newStatus);
        const body = formatStatusMessage(change.rideName, change.oldStatus, change.newStatus);
        notificationResults = await sendNotification(title, body, {
          rideId: change.rideId,
          rideName: change.rideName,
          oldStatus: change.oldStatus,
          newStatus: change.newStatus,
          type: 'status_change',
        });
      }
    } else {
      // Send a summary for many changes
      const messages = statusChanges.map(change =>
        `• ${change.rideName}: ${change.oldStatus} → ${change.newStatus}`
      );
      const title = `${statusChanges.length} Ride Status Changes`;
      const body = `🎢 ${statusChanges.length} rides changed:\n${messages.join('\n')}`;
      notificationResults = await sendNotification(title, body, {
        type: 'status_change_summary',
        count: statusChanges.length.toString(),
      });
    }
  }

  return { checked: totalChecked, changes: totalChanges, ridesDown, notifications: notificationResults };
}

// Express app
const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Register device for push notifications
app.post('/devices', async (req, res) => {
  const { token, platform, deviceName } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    await registerDevice(token, { platform, deviceName });
    console.log(`Device registered: ${token.slice(0, 20)}... (${platform || 'ios'})`);
    res.status(200).json({
      success: true,
      message: 'Device registered for push notifications',
    });
  } catch (error) {
    console.error('Error registering device:', error);
    res.status(500).json({ error: error.message });
  }
});

// Unregister device
app.delete('/devices/:token', async (req, res) => {
  const { token } = req.params;

  try {
    await unregisterDevice(token);
    console.log(`Device unregistered: ${token.slice(0, 20)}...`);
    res.status(200).json({
      success: true,
      message: 'Device unregistered',
    });
  } catch (error) {
    console.error('Error unregistering device:', error);
    res.status(500).json({ error: error.message });
  }
});

// List registered devices (for debugging)
app.get('/devices', async (req, res) => {
  try {
    const devices = await getDeviceTokens();
    res.status(200).json({
      count: devices.length,
      devices: devices.map(d => ({
        token: `${d.token.slice(0, 20)}...`,
        platform: d.platform,
        registeredAt: d.registeredAt,
      })),
    });
  } catch (error) {
    console.error('Error listing devices:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test push notification endpoint
app.post('/test-push', async (req, res) => {
  const { title, body } = req.body;

  try {
    const result = await sendPushNotification(
      title || 'Test Notification',
      body || 'This is a test push notification from ride-watch',
      { type: 'test' }
    );
    res.status(200).json({
      success: true,
      result,
    });
  } catch (error) {
    console.error('Error sending test push:', error);
    res.status(500).json({ error: error.message });
  }
});

// Main check endpoint (triggered by Cloud Scheduler or Cloud Tasks)
app.post('/check', async (req, res) => {
  console.log('Starting ride status check...');
  const startTime = Date.now();

  try {
    const result = await checkStatusChanges();
    const duration = Date.now() - startTime;

    const nextInterval = result.ridesDown > 0
      ? config.alertIntervalSec
      : config.normalIntervalSec;

    console.log(`Check complete: ${result.checked} rides checked, ${result.changes} changes, ${result.ridesDown} down (${duration}ms)`);
    console.log(`Next check in ${nextInterval}s (${result.ridesDown > 0 ? 'alert mode' : 'normal mode'})`);

    await scheduleNextCheck(nextInterval);

    res.status(200).json({
      success: true,
      ridesChecked: result.checked,
      statusChanges: result.changes,
      ridesDown: result.ridesDown,
      notifications: result.notifications,
      nextCheckSec: nextInterval,
      mode: result.ridesDown > 0 ? 'alert' : 'normal',
      durationMs: duration,
    });
  } catch (error) {
    console.error('Error during status check:', error);
    await scheduleNextCheck(config.normalIntervalSec);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Also support GET for easy testing
app.get('/check', async (req, res) => {
  console.log('Starting ride status check (GET)...');
  const startTime = Date.now();

  try {
    const result = await checkStatusChanges();
    const duration = Date.now() - startTime;

    const nextInterval = result.ridesDown > 0
      ? config.alertIntervalSec
      : config.normalIntervalSec;

    console.log(`Check complete: ${result.checked} rides checked, ${result.changes} changes, ${result.ridesDown} down (${duration}ms)`);

    res.status(200).json({
      success: true,
      ridesChecked: result.checked,
      statusChanges: result.changes,
      ridesDown: result.ridesDown,
      notifications: result.notifications,
      nextCheckSec: nextInterval,
      mode: result.ridesDown > 0 ? 'alert' : 'normal',
      durationMs: duration,
      note: 'GET request - next check not auto-scheduled',
    });
  } catch (error) {
    console.error('Error during status check:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Endpoint to manually start the scheduling loop
app.post('/start', async (req, res) => {
  console.log('Starting scheduling loop...');

  try {
    await scheduleNextCheck(1);
    res.status(200).json({
      success: true,
      message: 'Scheduling loop started',
    });
  } catch (error) {
    console.error('Error starting scheduling loop:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'ride-watch',
    description: 'Disney theme park attraction status monitor',
    endpoints: {
      '/health': 'Health check',
      '/check': 'Trigger status check (POST auto-schedules next, GET does not)',
      '/start': 'Start the dynamic scheduling loop (POST)',
      '/devices': 'Register (POST), unregister (DELETE), or list (GET) devices',
      '/test-push': 'Send a test push notification (POST)',
    },
    config: {
      parksMonitored: config.parkIds.length,
      watchedRides: config.watchedRides.length || 'all',
      smsRecipients: config.recipientNumbers.length,
      smsEnabled: config.enableSms && !!twilioClient,
      pushEnabled: config.enablePush && firebaseInitialized,
      dynamicScheduling: config.dynamicScheduling,
      normalIntervalSec: config.normalIntervalSec,
      alertIntervalSec: config.alertIntervalSec,
    },
  });
});

// Start server
app.listen(config.port, () => {
  console.log(`ride-watch service listening on port ${config.port}`);
  console.log(`Monitoring ${config.parkIds.length} park(s)`);
  console.log(`Watching ${config.watchedRides.length || 'all'} ride(s)`);
  console.log(`SMS: ${config.enableSms && twilioClient ? `enabled (${config.recipientNumbers.length} recipients)` : 'disabled'}`);
  console.log(`Push: ${config.enablePush && firebaseInitialized ? 'enabled' : 'disabled'}`);
  console.log(`Dynamic scheduling: ${config.dynamicScheduling ? 'enabled' : 'disabled'}`);
  if (config.dynamicScheduling) {
    console.log(`  Normal interval: ${config.normalIntervalSec}s, Alert interval: ${config.alertIntervalSec}s`);
  }
});
