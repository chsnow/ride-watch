import express from 'express';
import { Firestore } from '@google-cloud/firestore';
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
};

// Initialize Firestore
const firestore = new Firestore();
const statusCollection = firestore.collection('ride-status');

// Initialize Twilio client
const twilioClient = config.twilioSid && config.twilioToken
  ? twilio(config.twilioSid, config.twilioToken)
  : null;

// ThemeParks Wiki API base URL
const API_BASE = 'https://api.themeparks.wiki/v1';

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
 * Format status change message
 */
function formatStatusMessage(rideName, oldStatus, newStatus) {
  return `🎢 ${rideName}: ${oldStatus || 'Unknown'} → ${newStatus}`;
}

/**
 * Process attractions and check for status changes
 */
async function checkStatusChanges() {
  if (config.parkIds.length === 0) {
    console.warn('No park IDs configured');
    return { checked: 0, changes: 0 };
  }

  let totalChecked = 0;
  let totalChanges = 0;
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

  return { checked: totalChecked, changes: totalChanges };
}

// Express app
const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Main check endpoint (triggered by Cloud Scheduler)
app.post('/check', async (req, res) => {
  console.log('Starting ride status check...');
  const startTime = Date.now();

  try {
    const result = await checkStatusChanges();
    const duration = Date.now() - startTime;

    console.log(`Check complete: ${result.checked} rides checked, ${result.changes} changes detected (${duration}ms)`);

    res.status(200).json({
      success: true,
      ridesChecked: result.checked,
      statusChanges: result.changes,
      durationMs: duration,
    });
  } catch (error) {
    console.error('Error during status check:', error);
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

    console.log(`Check complete: ${result.checked} rides checked, ${result.changes} changes detected (${duration}ms)`);

    res.status(200).json({
      success: true,
      ridesChecked: result.checked,
      statusChanges: result.changes,
      durationMs: duration,
    });
  } catch (error) {
    console.error('Error during status check:', error);
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
      '/check': 'Trigger status check (POST or GET)',
    },
    config: {
      parksMonitored: config.parkIds.length,
      watchedRides: config.watchedRides.length || 'all',
      recipientNumbers: config.recipientNumbers.length,
      twilioConfigured: !!twilioClient,
    },
  });
});

// Start server
app.listen(config.port, () => {
  console.log(`ride-watch service listening on port ${config.port}`);
  console.log(`Monitoring ${config.parkIds.length} park(s)`);
  console.log(`Watching ${config.watchedRides.length || 'all'} ride(s)`);
  console.log(`SMS recipients: ${config.recipientNumbers.length}`);
});
