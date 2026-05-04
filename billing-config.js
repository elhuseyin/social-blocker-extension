/**
 * Billing API base URL and optional shared secret.
 * Local: run the backend (see /backend) and keep default below.
 * Production: deploy backend with HTTPS, set PUBLIC_BASE_URL, paste URL here.
 *
 * Optional BILLING_CLIENT_SECRET: set the same value in backend/.env — requests
 * without the header are rejected (reduces casual API abuse; not a substitute
 * for keeping the extension binary private).
 */

/** No trailing slash */
export const BILLING_API_BASE = "http://127.0.0.1:8787";

/** Must match backend BILLING_CLIENT_SECRET if that env var is set */
export const BILLING_CLIENT_SECRET = "";
