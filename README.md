# ride-watch

A serverless service that monitors Disney theme park attraction status and sends push notifications when rides go down or come back up.

## Features

- Monitors attraction status from any Disney park (or other parks supported by ThemeParks Wiki API)
- Push notifications via Firebase Cloud Messaging (iOS/Android)
- Runs on Google Cloud Run with Cloud Scheduler triggers
- Persists state in Firestore between invocations
- Filter to monitor only specific rides or all attractions
- **Dynamic scheduling**: Checks every 5 minutes normally, every 1 minute when any ride is down

## Prerequisites

- Node.js 20+
- Google Cloud account with billing enabled
- Firebase project (for push notifications)
- gcloud CLI installed and configured

## Finding Park Entity IDs

The service uses the [ThemeParks Wiki API](https://api.themeparks.wiki). To find park entity IDs:

1. **List all destinations:**
   ```bash
   curl https://api.themeparks.wiki/v1/destinations | jq
   ```

2. **Common Walt Disney World park IDs:**
   - Magic Kingdom: `75ea578a-adc8-4116-a54d-dccb60765ef9`
   - EPCOT: `47f90d2c-e191-4239-a466-5892ef59a88b`
   - Hollywood Studios: `288747d1-8b4f-4a64-867e-ea7c9b27f003`
   - Animal Kingdom: `1c84a229-8862-4648-9c71-378ddd2c7693`

3. **Common Disneyland Resort park IDs:**
   - Disneyland: `7340550b-c14d-4def-80bb-acdb51d49a66`
   - Disney California Adventure: `832fcd51-ea19-4e77-85c7-75d5843b127c`

4. **View live data for a park:**
   ```bash
   curl https://api.themeparks.wiki/v1/entity/75ea578a-adc8-4116-a54d-dccb60765ef9/live | jq
   ```

## Firebase Setup

### 1. Create/Link Firebase Project

```bash
# If you don't have a Firebase project linked to your GCP project:
firebase projects:addfirebase $PROJECT_ID
```

Or use the [Firebase Console](https://console.firebase.google.com):
1. Click "Add project"
2. Select your existing GCP project
3. Enable Google Analytics (optional)

### 2. Add iOS App to Firebase

1. Go to Firebase Console → Project Settings → General
2. Click "Add app" → iOS
3. Enter your iOS bundle ID (e.g., `com.yourcompany.ridewatch`)
4. Download `GoogleService-Info.plist`
5. Add to your Xcode project

### 3. Enable Cloud Messaging

1. Go to Firebase Console → Project Settings → Cloud Messaging
2. For iOS, upload your APNs authentication key:
   - Go to [Apple Developer](https://developer.apple.com/account/resources/authkeys/list)
   - Create a new key with "Apple Push Notifications service (APNs)"
   - Download the `.p8` file
   - Upload to Firebase with your Key ID and Team ID

### 4. iOS App Requirements

Your iOS app needs to:

```swift
import UserNotifications
import FirebaseMessaging

// 1. Request notification permissions
func requestNotificationPermission() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
        if granted {
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }
}

// 2. Get FCM token and register with ride-watch service
func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
    guard let token = fcmToken else { return }

    // Register token with ride-watch backend
    let url = URL(string: "https://your-service.run.app/devices")!
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONEncoder().encode([
        "token": token,
        "platform": "ios",
        "deviceName": UIDevice.current.name
    ])

    URLSession.shared.dataTask(with: request).resume()
}
```

## Local Development

1. **Clone and install:**
   ```bash
   git clone <repo-url>
   cd ride-watch
   npm install
   ```

2. **Set up environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

3. **Run locally:**
   ```bash
   npm start
   ```

4. **Test the endpoints:**
   ```bash
   # Health check
   curl http://localhost:8080/health

   # Trigger a status check
   curl http://localhost:8080/check

   # Register a test device
   curl -X POST http://localhost:8080/devices \
     -H "Content-Type: application/json" \
     -d '{"token": "test-token", "platform": "ios"}'

   # Send test push notification
   curl -X POST http://localhost:8080/test-push \
     -H "Content-Type: application/json" \
     -d '{"title": "Test", "body": "Hello from ride-watch!"}'
   ```

## Google Cloud Deployment

### 1. Set up your project

```bash
export PROJECT_ID=your-project-id
gcloud config set project $PROJECT_ID

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudtasks.googleapis.com \
  cloudbuild.googleapis.com \
  firebase.googleapis.com \
  fcm.googleapis.com
```

### 2. Create Firestore database

```bash
gcloud firestore databases create --location=us-central1
```

### 3. Create Cloud Tasks queue (for dynamic scheduling)

```bash
gcloud tasks queues create ride-watch-queue --location=us-central1
```

### 4. Deploy to Cloud Run

```bash
gcloud run deploy ride-watch \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "DYNAMIC_SCHEDULING=true" \
  --set-env-vars "CLOUD_TASKS_LOCATION=us-central1" \
  --set-env-vars "CLOUD_TASKS_QUEUE=ride-watch-queue" \
  --set-env-vars "PARK_IDS=75ea578a-adc8-4116-a54d-dccb60765ef9" \
  --set-env-vars "WATCHED_RIDES=Space Mountain,Haunted Mansion"

# Get the service URL and update
SERVICE_URL=$(gcloud run services describe ride-watch --region us-central1 --format 'value(status.url)')
gcloud run services update ride-watch \
  --region us-central1 \
  --update-env-vars "SERVICE_URL=${SERVICE_URL}"
```

### 5. Set up scheduling

**Option A: Cloud Scheduler (static 5-minute intervals)**

```bash
gcloud scheduler jobs create http ride-watch-trigger \
  --location us-central1 \
  --schedule "*/5 * * * *" \
  --uri "${SERVICE_URL}/check" \
  --http-method POST
```

**Option B: Dynamic scheduling (recommended)**

```bash
# Start the self-scheduling loop
curl -X POST "${SERVICE_URL}/start"
```

**Option C: Hybrid**

```bash
# Backup scheduler at 10-minute intervals
gcloud scheduler jobs create http ride-watch-backup \
  --location us-central1 \
  --schedule "*/10 * * * *" \
  --uri "${SERVICE_URL}/check" \
  --http-method POST

# Start dynamic scheduling
curl -X POST "${SERVICE_URL}/start"
```

### 6. Test the deployment

```bash
# Health check
curl ${SERVICE_URL}/health

# View service config
curl ${SERVICE_URL}/

# List registered devices
curl ${SERVICE_URL}/devices

# Send test push notification
curl -X POST ${SERVICE_URL}/test-push \
  -H "Content-Type: application/json" \
  -d '{"title": "Test", "body": "Push notifications are working!"}'
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PARK_IDS` | Yes | Comma-separated park entity IDs to monitor |
| `WATCHED_RIDES` | No | Comma-separated ride names to filter (empty = all) |
| `GOOGLE_CLOUD_PROJECT` | Auto | GCP project ID (set automatically in Cloud Run) |
| `PORT` | No | Server port (default: 8080) |
| `DYNAMIC_SCHEDULING` | No | Set to `true` to enable Cloud Tasks scheduling |
| `CLOUD_TASKS_LOCATION` | No | Cloud Tasks location (default: us-central1) |
| `CLOUD_TASKS_QUEUE` | No | Cloud Tasks queue name (default: ride-watch-queue) |
| `SERVICE_URL` | For dynamic | Cloud Run service URL (required for dynamic scheduling) |
| `NORMAL_INTERVAL_SEC` | No | Check interval when all rides up (default: 300) |
| `ALERT_INTERVAL_SEC` | No | Check interval when rides down (default: 60) |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info and configuration summary |
| `/health` | GET | Health check for Cloud Run |
| `/check` | GET | Trigger status check (no auto-scheduling) |
| `/check` | POST | Trigger status check (auto-schedules next if enabled) |
| `/start` | POST | Start the dynamic scheduling loop |
| `/devices` | GET | List registered devices |
| `/devices` | POST | Register device for push notifications |
| `/devices/:token` | DELETE | Unregister a device |
| `/test-push` | POST | Send a test push notification |

## Device Registration

iOS/Android apps register for push notifications by calling:

```bash
POST /devices
Content-Type: application/json

{
  "token": "fcm-device-token-from-firebase-sdk",
  "platform": "ios",
  "deviceName": "John's iPhone"
}
```

Device tokens are stored in Firestore's `devices` collection. Invalid tokens are automatically marked inactive when FCM returns an error.

## Ride Status Values

Common status values from the ThemeParks Wiki API:

- `OPERATING` - Ride is running normally
- `DOWN` - Ride is temporarily closed (triggers alert mode)
- `CLOSED` - Ride is closed/scheduled (triggers alert mode)
- `REFURBISHMENT` - Ride is under refurbishment (triggers alert mode)

## Cost Considerations

- **Cloud Run:** Pay only when the service runs (~12-60 invocations/hour)
- **Cloud Tasks:** Free tier covers millions of operations
- **Firestore:** Free tier covers up to 50k reads/day
- **Cloud Scheduler:** Free tier covers up to 3 jobs
- **Firebase Cloud Messaging:** Free (no per-message cost)

## Troubleshooting

**No push notifications received:**
- Check device is registered: `curl ${SERVICE_URL}/devices`
- Verify Firebase project is set up correctly
- Check APNs key is uploaded in Firebase Console
- Test with: `curl -X POST ${SERVICE_URL}/test-push`
- Check Cloud Run logs: `gcloud run services logs read ride-watch`

**No status changes detected:**
- First run populates Firestore with initial state (no changes detected)
- Changes are only detected on subsequent runs
- Verify PARK_IDS are correct

**Dynamic scheduling not working:**
- Ensure `DYNAMIC_SCHEDULING=true`
- Verify `SERVICE_URL` is set correctly
- Check Cloud Tasks queue exists

**Invalid device tokens:**
- Tokens are automatically marked invalid when FCM returns errors
- Check Firestore `devices` collection for `invalid: true` entries
- App should re-register token when it refreshes

## License

MIT
