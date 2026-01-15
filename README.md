# ride-watch

A serverless service that monitors Disney theme park attraction status and sends SMS notifications when rides go down or come back up.

## Features

- Monitors attraction status from any Disney park (or other parks supported by ThemeParks Wiki API)
- Sends SMS notifications via Twilio when ride status changes
- Runs on Google Cloud Run with Cloud Scheduler triggers
- Persists state in Firestore between invocations
- Filter to monitor only specific rides or all attractions
- Supports multiple SMS recipients

## Prerequisites

- Node.js 20+
- Google Cloud account with billing enabled
- Twilio account
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

## Twilio Setup

1. **Create a Twilio account** at https://www.twilio.com

2. **Get your credentials:**
   - Account SID (found on dashboard)
   - Auth Token (found on dashboard)
   - Buy a phone number for sending SMS

3. **Note:** Phone numbers must be in E.164 format (e.g., `+12025551234`)

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

3. **Set up local Firestore emulator (optional):**
   ```bash
   gcloud emulators firestore start
   export FIRESTORE_EMULATOR_HOST="localhost:8080"
   ```

4. **Run locally:**
   ```bash
   npm start
   ```

5. **Test the endpoints:**
   ```bash
   # Health check
   curl http://localhost:8080/health

   # Trigger a status check
   curl http://localhost:8080/check
   ```

## Google Cloud Deployment

### 1. Set up your project

```bash
# Set your project
export PROJECT_ID=your-project-id
gcloud config set project $PROJECT_ID

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com
```

### 2. Create Firestore database

```bash
# Create Firestore in Native mode (choose your region)
gcloud firestore databases create --location=us-central1
```

### 3. Deploy to Cloud Run

```bash
# Build and deploy
gcloud run deploy ride-watch \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "TWILIO_SID=your_sid" \
  --set-env-vars "TWILIO_TOKEN=your_token" \
  --set-env-vars "TWILIO_NUMBER=+1234567890" \
  --set-env-vars "RECIPIENT_NUMBERS=+1234567890" \
  --set-env-vars "PARK_IDS=75ea578a-adc8-4116-a54d-dccb60765ef9" \
  --set-env-vars "WATCHED_RIDES=Space Mountain,Haunted Mansion"
```

**Using Secret Manager (recommended for production):**

```bash
# Create secrets
echo -n "your_twilio_sid" | gcloud secrets create twilio-sid --data-file=-
echo -n "your_twilio_token" | gcloud secrets create twilio-token --data-file=-

# Deploy with secrets
gcloud run deploy ride-watch \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-secrets "TWILIO_SID=twilio-sid:latest,TWILIO_TOKEN=twilio-token:latest" \
  --set-env-vars "TWILIO_NUMBER=+1234567890" \
  --set-env-vars "RECIPIENT_NUMBERS=+1234567890" \
  --set-env-vars "PARK_IDS=75ea578a-adc8-4116-a54d-dccb60765ef9" \
  --set-env-vars "WATCHED_RIDES=Space Mountain,Haunted Mansion"
```

### 4. Set up Cloud Scheduler

```bash
# Get the Cloud Run service URL
SERVICE_URL=$(gcloud run services describe ride-watch --region us-central1 --format 'value(status.url)')

# Create a scheduler job to run every 5 minutes
gcloud scheduler jobs create http ride-watch-trigger \
  --location us-central1 \
  --schedule "*/5 * * * *" \
  --uri "${SERVICE_URL}/check" \
  --http-method POST \
  --oidc-service-account-email "${PROJECT_ID}@appspot.gserviceaccount.com"
```

**Note:** If using `--allow-unauthenticated` on Cloud Run, you can omit the `--oidc-service-account-email` flag.

### 5. Test the deployment

```bash
# Health check
curl ${SERVICE_URL}/health

# Manual trigger
curl -X POST ${SERVICE_URL}/check
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TWILIO_SID` | Yes | Twilio Account SID |
| `TWILIO_TOKEN` | Yes | Twilio Auth Token |
| `TWILIO_NUMBER` | Yes | Twilio phone number (E.164 format) |
| `RECIPIENT_NUMBERS` | Yes | Comma-separated recipient phone numbers |
| `PARK_IDS` | Yes | Comma-separated park entity IDs to monitor |
| `WATCHED_RIDES` | No | Comma-separated ride names to filter (empty = all) |
| `GOOGLE_CLOUD_PROJECT` | Auto | GCP project ID (set automatically in Cloud Run) |
| `PORT` | No | Server port (default: 8080) |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info and configuration summary |
| `/health` | GET | Health check for Cloud Run |
| `/check` | GET/POST | Trigger status check and send notifications |

## Ride Status Values

Common status values from the ThemeParks Wiki API:

- `OPERATING` - Ride is running normally
- `DOWN` - Ride is temporarily closed
- `CLOSED` - Ride is closed (scheduled)
- `REFURBISHMENT` - Ride is under refurbishment

## Cost Considerations

- **Cloud Run:** Pay only when the service runs (~12 invocations/hour)
- **Firestore:** Free tier covers up to 50k reads/day
- **Cloud Scheduler:** Free tier covers up to 3 jobs
- **Twilio:** ~$0.0079/SMS in the US

## Troubleshooting

**No SMS received:**
- Check Twilio credentials are correct
- Verify phone numbers are in E.164 format
- Check Cloud Run logs: `gcloud run services logs read ride-watch`

**No status changes detected:**
- First run populates Firestore with initial state (no changes detected)
- Changes are only detected on subsequent runs
- Verify PARK_IDS are correct

**Firestore permission errors:**
- Ensure the Cloud Run service account has Firestore access
- Default service account usually has access automatically

## License

MIT
