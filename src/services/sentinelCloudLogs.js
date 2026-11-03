import { Logging } from '@google-cloud/logging';

let loggingClient = null;

export function getLoggingClient() {
  if (!loggingClient) {
    // Uses Google Application Default Credentials in GCP
    loggingClient = new Logging({
      projectId: process.env.GOOGLE_CLOUD_PROJECT || undefined
    });
  }
  return loggingClient;
}

/**
 * v1.51.9 — revision-rollout lifecycle wording (Ready condition, probe
 * failures, instance-not-started, CANCELLED handshakes). Used to skip rollout
 * noise before the worker classifies a payload.
 */
const ROLLOUT_LIFECYCLE_RE = /(?:readiness|startup|liveness)\s+probe\s+failed|ready\s+condition|instance\s+was\s+not\s+started|connection\s+failed\s+with\s+status\s+cancelled|revision\s+[^'\s]+(?:\s+is)?\s+not\s+ready|container\s+failed\s+to\s+start|waiting\s+for\s+revision|deploying\s+revision/i;

/** True when a Cloud Logging entry is a revision-rollout lifecycle record. */
export function isRolloutLifecycleEntry(entry) {
  try {
    const raw = String(entry?.text || entry?.message
      || (entry?.value?.data ? JSON.stringify(entry.value.data) : '')
      || JSON.stringify(entry || {}));
    return ROLLOUT_LIFECYCLE_RE.test(raw);
  } catch { return false; }
}

/**
 * Fetches recent logs from Google Cloud Run for the saka-fleet service.
 * Filters for severity ERROR/CRITICAL or high latency.
 */
export async function fetchCloudRunLogs(minutesAgo = 5) {
  try {
    const client = getLoggingClient();
    const serviceName = process.env.K_SERVICE || 'saka-fleet';
    
    // Construct the time window ISO string
    const timestamp = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
    
    const filter = `
      resource.type="cloud_run_revision"
      resource.labels.service_name="${serviceName}"
      timestamp >= "${timestamp}"
      (severity >= ERROR OR httpRequest.latency >= "5.000s")
    `;

    // getEntries takes an options object
    const [entries] = await client.getEntries({
      filter,
      orderBy: 'timestamp desc',
      pageSize: 50
    });

    return entries.map(entry => {
      const payload = entry.data || entry.textPayload || entry.jsonPayload || {};
      // v1.51.9 — classify payloads at the source: textPayload, then the
      // api/jsonPayload message, then decoded AuditLog byte-array text.
      let message;
      if (typeof payload === 'string') {
        message = payload;
      } else if (entry.textPayload) {
        message = entry.textPayload;
      } else if (entry.data && entry.data.message) {
        message = entry.data.message;
      } else if (entry.jsonPayload && entry.jsonPayload.message) {
        message = entry.jsonPayload.message;
      } else if (payload && payload.message) {
        message = payload.message;
      } else if (payload && payload.type_url && payload.value && Array.isArray(payload.value.data)) {
        message = payload.value.data
          .filter((b) => Number.isInteger(b) && b >= 0 && b <= 255)
          .map((b) => String.fromCharCode(b))
          .join('');
      } else {
        message = JSON.stringify(payload);
      }
      
      const reqInfo = entry.metadata?.httpRequest || {};
      let latencySeconds = 0;
      if (reqInfo.latency) {
        if (typeof reqInfo.latency === 'string') {
          latencySeconds = parseFloat(reqInfo.latency.replace('s', ''));
        } else if (typeof reqInfo.latency === 'object' && reqInfo.latency.seconds) {
          latencySeconds = parseInt(reqInfo.latency.seconds, 10);
        }
      }

      return {
        timestamp: entry.metadata?.timestamp || new Date().toISOString(),
        severity: entry.metadata?.severity || 'DEFAULT',
        text: message,
        httpRequest: {
          status: reqInfo.status || null,
          latency: latencySeconds,
          requestUrl: reqInfo.requestUrl || null
        },
        trace: entry.metadata?.trace || null
      };
    });
  } catch (error) {
    // Graceful fallback for non-GCP environments
    console.warn('[sentinelCloudLogs] Could not fetch Cloud Run logs (expected in local/dev):', error.message);
    return [];
  }
}
