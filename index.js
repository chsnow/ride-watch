import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { CloudTasksClient } from '@google-cloud/tasks';
import admin from 'firebase-admin';

// Configuration from environment variables
const config = {
  parkIds: (process.env.PARK_IDS || '').split(',').filter(Boolean),
  watchedRides: (process.env.WATCHED_RIDES || '').split(',').filter(Boolean),
  port: parseInt(process.env.PORT || '8080', 10),
  // Dynamic scheduling config
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.CLOUD_TASKS_LOCATION || 'us-central1',
  queueName: process.env.CLOUD_TASKS_QUEUE || 'ride-watch-queue',
  serviceUrl: process.env.SERVICE_URL,
  // Intervals in seconds
  checkIntervalSec: parseInt(process.env.CHECK_INTERVAL_SEC || '30', 10),
  // Bedtime config (pause polling during off-hours)
  bedtimeStart: parseInt(process.env.BEDTIME_START || '1', 10), // Hour to start bedtime (0-23, default 1am)
  bedtimeEnd: parseInt(process.env.BEDTIME_END || '7', 10),     // Hour to end bedtime (0-23, default 7am)
  bedtimeTimezone: process.env.BEDTIME_TIMEZONE || 'America/New_York',
  // Feature flags
  dynamicScheduling: process.env.DYNAMIC_SCHEDULING === 'true',
  bedtimeEnabled: process.env.BEDTIME_ENABLED !== 'false', // Enabled by default
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

// ============================================
// IN-MEMORY CACHE
// ============================================

// Cache for ride statuses: { rideId: { status, rideName, updatedAt } }
const statusCache = new Map();
let statusCacheInitialized = false;

// Cache for device tokens: { tokens: [...], loadedAt: timestamp }
let deviceCache = { tokens: [], loadedAt: 0 };
const DEVICE_CACHE_TTL_MS = 60000; // Refresh device list every 60 seconds

/**
 * Initialize status cache from Firestore (only on cold start)
 */
async function initializeStatusCache() {
  if (statusCacheInitialized) return;

  console.log('Initializing status cache from Firestore...');
  try {
    const snapshot = await statusCollection.get();
    snapshot.forEach(doc => {
      statusCache.set(doc.id, doc.data());
    });
    statusCacheInitialized = true;
    console.log(`Status cache initialized with ${statusCache.size} rides`);
  } catch (error) {
    console.error('Failed to initialize status cache:', error.message);
    // Continue without cache - will populate as we go
    statusCacheInitialized = true;
  }
}

/**
 * Get previous status from cache (no Firestore read)
 */
function getPreviousStatus(rideId) {
  return statusCache.get(rideId) || null;
}

/**
 * Save status to cache and Firestore (only if changed)
 */
async function saveStatus(rideId, status, rideName) {
  const previous = statusCache.get(rideId);
  const hasChanged = !previous || previous.status !== status;

  // Always update cache
  const data = {
    status,
    rideName,
    updatedAt: new Date().toISOString(),
  };
  statusCache.set(rideId, data);

  // Only write to Firestore if status changed
  if (hasChanged) {
    await statusCollection.doc(rideId).set(data);
    return true; // Indicates a write occurred
  }
  return false;
}

// ============================================
// ThemeParks Wiki API
// ============================================

const API_BASE = 'https://api.themeparks.wiki/v1';
const DOWN_STATUSES = new Set(['DOWN', 'REFURBISHMENT', 'CLOSED']);

async function fetchParkLiveData(parkId) {
  const url = `${API_BASE}/entity/${parkId}/live`;
  console.log(`Fetching live data for park: ${parkId}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch park data: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// ============================================
// DEVICE MANAGEMENT (with caching)
// ============================================

async function getDeviceTokens() {
  const now = Date.now();

  // Return cached tokens if still fresh
  if (deviceCache.tokens.length > 0 && (now - deviceCache.loadedAt) < DEVICE_CACHE_TTL_MS) {
    return deviceCache.tokens;
  }

  // Refresh from Firestore
  console.log('Refreshing device tokens from Firestore...');
  const snapshot = await devicesCollection.where('active', '==', true).get();
  const tokens = snapshot.docs.map(doc => ({
    token: doc.id,
    ...doc.data(),
  }));

  deviceCache = { tokens, loadedAt: now };
  console.log(`Device cache refreshed: ${tokens.length} active device(s)`);

  return tokens;
}

async function registerDevice(token, metadata = {}) {
  const cleanMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([_, v]) => v !== undefined)
  );

  await devicesCollection.doc(token).set({
    active: true,
    registeredAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    platform: cleanMetadata.platform || 'ios',
    ...cleanMetadata,
  }, { merge: true });

  // Invalidate device cache
  deviceCache.loadedAt = 0;
}

async function unregisterDevice(token) {
  await devicesCollection.doc(token).update({
    active: false,
    unregisteredAt: new Date().toISOString(),
  });

  // Invalidate device cache
  deviceCache.loadedAt = 0;
}

async function markTokenInvalid(token) {
  await devicesCollection.doc(token).update({
    active: false,
    invalid: true,
    invalidatedAt: new Date().toISOString(),
  });

  // Invalidate device cache
  deviceCache.loadedAt = 0;
}

// ============================================
// PUSH NOTIFICATIONS
// ============================================

async function sendPushNotification(title, body, data = {}) {
  if (!firebaseInitialized) {
    console.warn('Firebase not initialized, skipping push notification');
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

  for (const device of devices) {
    try {
      const message = {
        token: device.token,
        notification: { title, body },
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

// ============================================
// BEDTIME LOGIC
// ============================================

/**
 * Get current hour in the configured timezone
 */
function getCurrentHourInTimezone() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.bedtimeTimezone,
    hour: 'numeric',
    hour12: false,
  });
  return parseInt(formatter.format(now), 10);
}

/**
 * Check if we're currently in bedtime hours
 */
function isBedtime() {
  if (!config.bedtimeEnabled) return false;

  const currentHour = getCurrentHourInTimezone();
  const { bedtimeStart, bedtimeEnd } = config;

  // Handle overnight bedtime (e.g., 1am to 7am)
  if (bedtimeStart < bedtimeEnd) {
    return currentHour >= bedtimeStart && currentHour < bedtimeEnd;
  }
  // Handle cross-midnight bedtime (e.g., 11pm to 7am)
  return currentHour >= bedtimeStart || currentHour < bedtimeEnd;
}

/**
 * Calculate seconds until bedtime ends
 */
function getSecondsUntilBedtimeEnds() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.bedtimeTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // Parse current time in the target timezone
  const parts = formatter.formatToParts(now);
  const getPart = (type) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);

  const currentHour = getPart('hour');
  const currentMinute = getPart('minute');
  const currentSecond = getPart('second');

  // Calculate seconds until bedtime end hour
  let hoursUntilEnd;
  if (currentHour < config.bedtimeEnd) {
    hoursUntilEnd = config.bedtimeEnd - currentHour;
  } else {
    // We're past bedtime end, so it ends tomorrow
    hoursUntilEnd = 24 - currentHour + config.bedtimeEnd;
  }

  // Convert to seconds, subtracting current minutes and seconds
  const secondsUntilEnd = (hoursUntilEnd * 3600) - (currentMinute * 60) - currentSecond;

  // Add a small buffer to ensure we're past the bedtime end
  return Math.max(secondsUntilEnd + 60, 60);
}

// ============================================
// HELPERS
// ============================================

function shouldMonitorRide(rideName) {
  if (config.watchedRides.length === 0) return true;
  return config.watchedRides.some(watched =>
    rideName.toLowerCase().includes(watched.toLowerCase().trim())
  );
}

function isDownStatus(status) {
  return DOWN_STATUSES.has(status);
}

function formatStatusMessage(rideName, oldStatus, newStatus) {
  return `${rideName}: ${oldStatus || 'Unknown'} → ${newStatus}`;
}

function getNotificationTitle(newStatus) {
  if (newStatus === 'OPERATING') return 'Ride Back Up! 🎉';
  if (newStatus === 'DOWN') return 'Ride Down ⚠️';
  if (newStatus === 'CLOSED') return 'Ride Closed';
  if (newStatus === 'REFURBISHMENT') return 'Ride Under Refurbishment';
  return 'Ride Status Changed';
}

// ============================================
// SCHEDULING
// ============================================

/**
 * Determine the delay for the next check, accounting for bedtime
 * Returns { delaySeconds, reason }
 */
function getNextCheckDelay(normalDelaySeconds) {
  if (isBedtime()) {
    const delaySeconds = getSecondsUntilBedtimeEnds();
    const hours = Math.floor(delaySeconds / 3600);
    const minutes = Math.floor((delaySeconds % 3600) / 60);
    return {
      delaySeconds,
      reason: `bedtime (sleeping for ${hours}h ${minutes}m until ${config.bedtimeEnd}:00)`,
      isBedtime: true,
    };
  }
  return {
    delaySeconds: normalDelaySeconds,
    reason: 'normal interval',
    isBedtime: false,
  };
}

async function scheduleNextCheck(delaySeconds) {
  if (!config.dynamicScheduling) {
    console.log('Dynamic scheduling disabled, skipping task creation');
    return { scheduled: false, reason: 'dynamic scheduling disabled' };
  }

  if (!config.projectId || !config.serviceUrl) {
    console.warn('Missing PROJECT_ID or SERVICE_URL, cannot schedule next check');
    return { scheduled: false, reason: 'missing config' };
  }

  // Check for bedtime and adjust delay if needed
  const nextCheck = getNextCheckDelay(delaySeconds);

  const queuePath = tasksClient.queuePath(
    config.projectId,
    config.location,
    config.queueName
  );

  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: `${config.serviceUrl}/check`,
      headers: { 'Content-Type': 'application/json' },
    },
    scheduleTime: {
      seconds: Math.floor(Date.now() / 1000) + nextCheck.delaySeconds,
    },
  };

  try {
    const [response] = await tasksClient.createTask({ parent: queuePath, task });
    console.log(`Scheduled next check in ${nextCheck.delaySeconds}s (${nextCheck.reason}): ${response.name}`);
    return {
      scheduled: true,
      delaySeconds: nextCheck.delaySeconds,
      reason: nextCheck.reason,
      isBedtime: nextCheck.isBedtime,
    };
  } catch (error) {
    console.error('Failed to schedule next check:', error.message);
    return { scheduled: false, reason: error.message };
  }
}

// ============================================
// MAIN STATUS CHECK
// ============================================

async function checkStatusChanges() {
  // Initialize cache on first run
  await initializeStatusCache();

  if (config.parkIds.length === 0) {
    console.warn('No park IDs configured');
    return { checked: 0, changes: 0, ridesDown: 0, firestoreWrites: 0, notifications: null };
  }

  let totalChecked = 0;
  let totalChanges = 0;
  let ridesDown = 0;
  let firestoreWrites = 0;
  const statusChanges = [];
  const nonOperatingRides = [];

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

        if (!shouldMonitorRide(rideName)) continue;

        totalChecked++;

        if (isDownStatus(currentStatus)) {
          ridesDown++;
          nonOperatingRides.push({ name: rideName, status: currentStatus });
        }

        // Get previous status from cache (no Firestore read!)
        const previousData = getPreviousStatus(rideId);
        const previousStatus = previousData?.status;

        // Detect changes
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

        // Save to cache + Firestore (only writes if changed)
        const didWrite = await saveStatus(rideId, currentStatus, rideName);
        if (didWrite) firestoreWrites++;
      }
    } catch (error) {
      console.error(`Error processing park ${parkId}:`, error.message);
    }
  }

  // Log non-operating rides
  if (nonOperatingRides.length > 0) {
    console.log(`Non-operating rides (${nonOperatingRides.length}):`);
    for (const ride of nonOperatingRides) {
      console.log(`  - ${ride.name}: ${ride.status}`);
    }
  } else {
    console.log('All monitored rides are operating');
  }

  // Send push notifications for status changes
  let notificationResults = null;
  if (statusChanges.length > 0) {
    if (statusChanges.length <= 3) {
      for (const change of statusChanges) {
        const title = getNotificationTitle(change.newStatus);
        const body = formatStatusMessage(change.rideName, change.oldStatus, change.newStatus);
        notificationResults = await sendPushNotification(title, body, {
          rideId: change.rideId,
          rideName: change.rideName,
          oldStatus: change.oldStatus,
          newStatus: change.newStatus,
          type: 'status_change',
        });
      }
    } else {
      const messages = statusChanges.map(change =>
        `• ${change.rideName}: ${change.oldStatus} → ${change.newStatus}`
      );
      const title = `${statusChanges.length} Ride Status Changes`;
      const body = messages.join('\n');
      notificationResults = await sendPushNotification(title, body, {
        type: 'status_change_summary',
        count: statusChanges.length.toString(),
      });
    }
  }

  return {
    checked: totalChecked,
    changes: totalChanges,
    ridesDown,
    firestoreWrites,
    cacheSize: statusCache.size,
    notifications: notificationResults,
  };
}

// ============================================
// EXPRESS APP
// ============================================

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

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

app.delete('/devices/:token', async (req, res) => {
  const { token } = req.params;

  try {
    await unregisterDevice(token);
    console.log(`Device unregistered: ${token.slice(0, 20)}...`);
    res.status(200).json({ success: true, message: 'Device unregistered' });
  } catch (error) {
    console.error('Error unregistering device:', error);
    res.status(500).json({ error: error.message });
  }
});

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

app.post('/test-push', async (req, res) => {
  const { title, body } = req.body;

  try {
    const result = await sendPushNotification(
      title || 'Test Notification',
      body || 'This is a test push notification from ride-watch',
      { type: 'test' }
    );
    res.status(200).json({ success: true, result });
  } catch (error) {
    console.error('Error sending test push:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/check', async (req, res) => {
  const startTime = Date.now();

  // Check if we're in bedtime mode - skip status check and schedule wake-up
  if (isBedtime()) {
    console.log(`Bedtime mode active (${config.bedtimeStart}:00 - ${config.bedtimeEnd}:00 ${config.bedtimeTimezone})`);
    const scheduleResult = await scheduleNextCheck(config.checkIntervalSec);
    const duration = Date.now() - startTime;

    return res.status(200).json({
      success: true,
      bedtime: true,
      message: `Skipping check - bedtime mode (${config.bedtimeStart}:00 - ${config.bedtimeEnd}:00)`,
      nextCheckSec: scheduleResult.delaySeconds,
      scheduleReason: scheduleResult.reason,
      durationMs: duration,
    });
  }

  console.log('Starting ride status check...');

  try {
    const result = await checkStatusChanges();
    const duration = Date.now() - startTime;

    console.log(`Check complete: ${result.checked} rides, ${result.changes} changes, ${result.firestoreWrites} writes (${duration}ms)`);

    const scheduleResult = await scheduleNextCheck(config.checkIntervalSec);

    res.status(200).json({
      success: true,
      bedtime: false,
      ridesChecked: result.checked,
      statusChanges: result.changes,
      ridesDown: result.ridesDown,
      firestoreWrites: result.firestoreWrites,
      cacheSize: result.cacheSize,
      notifications: result.notifications,
      nextCheckSec: scheduleResult.delaySeconds || config.checkIntervalSec,
      scheduleReason: scheduleResult.reason,
      durationMs: duration,
    });
  } catch (error) {
    console.error('Error during status check:', error);
    await scheduleNextCheck(config.checkIntervalSec);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/check', async (req, res) => {
  console.log('Starting ride status check (GET)...');
  const startTime = Date.now();

  try {
    const result = await checkStatusChanges();
    const duration = Date.now() - startTime;

    console.log(`Check complete: ${result.checked} rides, ${result.changes} changes, ${result.firestoreWrites} writes (${duration}ms)`);

    res.status(200).json({
      success: true,
      ridesChecked: result.checked,
      statusChanges: result.changes,
      ridesDown: result.ridesDown,
      firestoreWrites: result.firestoreWrites,
      cacheSize: result.cacheSize,
      notifications: result.notifications,
      nextCheckSec: config.checkIntervalSec,
      durationMs: duration,
      note: 'GET request - next check not auto-scheduled',
    });
  } catch (error) {
    console.error('Error during status check:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/start', async (req, res) => {
  console.log('Starting scheduling loop...');

  try {
    await scheduleNextCheck(1);
    res.status(200).json({ success: true, message: 'Scheduling loop started' });
  } catch (error) {
    console.error('Error starting scheduling loop:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/cache', (req, res) => {
  res.status(200).json({
    statusCache: {
      size: statusCache.size,
      initialized: statusCacheInitialized,
    },
    deviceCache: {
      count: deviceCache.tokens.length,
      ageMs: Date.now() - deviceCache.loadedAt,
      ttlMs: DEVICE_CACHE_TTL_MS,
    },
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'ride-watch',
    description: 'Disney theme park attraction status monitor',
    endpoints: {
      '/health': 'Health check',
      '/check': 'Trigger status check (POST auto-schedules next, GET does not)',
      '/start': 'Start the scheduling loop (POST)',
      '/devices': 'Register (POST), unregister (DELETE), or list (GET) devices',
      '/test-push': 'Send a test push notification (POST)',
      '/cache': 'View cache stats',
    },
    config: {
      parksMonitored: config.parkIds.length,
      watchedRides: config.watchedRides.length || 'all',
      pushEnabled: firebaseInitialized,
      dynamicScheduling: config.dynamicScheduling,
      checkIntervalSec: config.checkIntervalSec,
    },
    bedtime: {
      enabled: config.bedtimeEnabled,
      start: `${config.bedtimeStart}:00`,
      end: `${config.bedtimeEnd}:00`,
      timezone: config.bedtimeTimezone,
      currentlyActive: isBedtime(),
      currentHour: getCurrentHourInTimezone(),
    },
    cache: {
      statusCacheSize: statusCache.size,
      deviceCacheCount: deviceCache.tokens.length,
    },
  });
});

app.listen(config.port, () => {
  console.log(`ride-watch service listening on port ${config.port}`);
  console.log(`Monitoring ${config.parkIds.length} park(s)`);
  console.log(`Watching ${config.watchedRides.length || 'all'} ride(s)`);
  console.log(`Push notifications: ${firebaseInitialized ? 'enabled' : 'disabled'}`);
  console.log(`Check interval: ${config.checkIntervalSec}s`);
  console.log(`Dynamic scheduling: ${config.dynamicScheduling ? 'enabled' : 'disabled'}`);
  if (config.bedtimeEnabled) {
    console.log(`Bedtime: ${config.bedtimeStart}:00 - ${config.bedtimeEnd}:00 ${config.bedtimeTimezone}`);
  } else {
    console.log('Bedtime: disabled');
  }
});
