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
      const message = typeof payload === 'string' ? payload : (payload.message || JSON.stringify(payload));
      
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
