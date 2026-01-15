import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { CloudTasksClient } from '@google-cloud/tasks';
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
  serviceUrl: process.env.SERVICE_URL, // Cloud Run service URL
  // Intervals in seconds
  normalIntervalSec: parseInt(process.env.NORMAL_INTERVAL_SEC || '300', 10), // 5 minutes
  alertIntervalSec: parseInt(process.env.ALERT_INTERVAL_SEC || '60', 10),    // 1 minute
  // Feature flag for dynamic scheduling
  dynamicScheduling: process.env.DYNAMIC_SCHEDULING === 'true',
};

// Initialize Firestore
const firestore = new Firestore();
const statusCollection = firestore.collection('ride-status');

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
 * Send SMS notification via Twilio
 */
async function sendSmsNotification(message) {
  if (!twilioClient) {
    console.warn('Twilio not configured, skipping SMS notification');
    console.log(`Would have sent: ${message}`);
    return;
  }

  if (config.recipientNumbers.length === 0) {
    console.warn('No recipient numbers configured');
    return;
  }

  console.log(`Sending SMS to ${config.recipientNumbers.length} recipient(s)`);

  const sendPromises = config.recipientNumbers.map(async (to) => {
    try {
      await twilioClient.messages.create({
        body: message,
        from: config.twilioNumber,
        to: to.trim(),
      });
      console.log(`SMS sent to ${to}`);
    } catch (error) {
      console.error(`Failed to send SMS to ${to}:`, error.message);
    }
  });

  await Promise.all(sendPromises);
}

/**
 * Check if a ride should be monitored based on watched rides config
 */
function shouldMonitorRide(rideName) {
  if (config.watchedRides.length === 0) {
    return true; // Monitor all rides if no filter set
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
    return { checked: 0, changes: 0, ridesDown: 0 };
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

      // Filter to only ATTRACTION entity types
      const attractions = liveData.liveData.filter(
        entity => entity.entityType === 'ATTRACTION'
      );

      console.log(`Found ${attractions.length} attractions in park ${parkId}`);

      for (const attraction of attractions) {
        const rideId = attraction.id;
        const rideName = attraction.name;
        const currentStatus = attraction.status || 'UNKNOWN';

        // Skip if not in watched list
        if (!shouldMonitorRide(rideName)) {
          continue;
        }

        totalChecked++;

        // Track if ride is down
        if (isDownStatus(currentStatus)) {
          ridesDown++;
        }

        // Get previous status from Firestore
        const previousData = await getPreviousStatus(rideId);
        const previousStatus = previousData?.status;

        // Check for status change
        if (previousStatus && previousStatus !== currentStatus) {
          console.log(`Status change detected: ${rideName} (${previousStatus} → ${currentStatus})`);
          totalChanges++;
          statusChanges.push({
            rideName,
            oldStatus: previousStatus,
            newStatus: currentStatus,
          });
        }

        // Save current status
        await saveStatus(rideId, currentStatus, rideName);
      }
    } catch (error) {
      console.error(`Error processing park ${parkId}:`, error.message);
    }
  }

  // Send notifications for all status changes
  if (statusChanges.length > 0) {
    // Group messages if there are multiple changes
    if (statusChanges.length <= 3) {
      // Send individual messages for small number of changes
      for (const change of statusChanges) {
        const message = formatStatusMessage(change.rideName, change.oldStatus, change.newStatus);
        await sendSmsNotification(message);
      }
    } else {
      // Send a summary message for many changes
      const messages = statusChanges.map(change =>
        `• ${change.rideName}: ${change.oldStatus} → ${change.newStatus}`
      );
      const summaryMessage = `🎢 ${statusChanges.length} ride status changes:\n${messages.join('\n')}`;
      await sendSmsNotification(summaryMessage);
    }
  }

  return { checked: totalChecked, changes: totalChanges, ridesDown };
}

// Express app
const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Main check endpoint (triggered by Cloud Scheduler or Cloud Tasks)
app.post('/check', async (req, res) => {
  console.log('Starting ride status check...');
  const startTime = Date.now();

  try {
    const result = await checkStatusChanges();
    const duration = Date.now() - startTime;

    // Determine next check interval based on rides down
    const nextInterval = result.ridesDown > 0
      ? config.alertIntervalSec
      : config.normalIntervalSec;

    console.log(`Check complete: ${result.checked} rides checked, ${result.changes} changes, ${result.ridesDown} down (${duration}ms)`);
    console.log(`Next check in ${nextInterval}s (${result.ridesDown > 0 ? 'alert mode' : 'normal mode'})`);

    // Schedule next check dynamically
    await scheduleNextCheck(nextInterval);

    res.status(200).json({
      success: true,
      ridesChecked: result.checked,
      statusChanges: result.changes,
      ridesDown: result.ridesDown,
      nextCheckSec: nextInterval,
      mode: result.ridesDown > 0 ? 'alert' : 'normal',
      durationMs: duration,
    });
  } catch (error) {
    console.error('Error during status check:', error);

    // Even on error, schedule next check at normal interval
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

    // Don't auto-schedule on GET (manual test), but show what would happen
    res.status(200).json({
      success: true,
      ridesChecked: result.checked,
      statusChanges: result.changes,
      ridesDown: result.ridesDown,
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
    await scheduleNextCheck(1); // Schedule first check in 1 second
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
    },
    config: {
      parksMonitored: config.parkIds.length,
      watchedRides: config.watchedRides.length || 'all',
      recipientNumbers: config.recipientNumbers.length,
      twilioConfigured: !!twilioClient,
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
  console.log(`SMS recipients: ${config.recipientNumbers.length}`);
  console.log(`Dynamic scheduling: ${config.dynamicScheduling ? 'enabled' : 'disabled'}`);
  if (config.dynamicScheduling) {
    console.log(`  Normal interval: ${config.normalIntervalSec}s, Alert interval: ${config.alertIntervalSec}s`);
  }
});
