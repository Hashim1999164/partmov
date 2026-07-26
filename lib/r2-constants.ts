/** Shared R2 upload sizing (safe for client + server). */

/** Safe under typical serverless request body limits (Vercel ~4.5 MiB). */
export const R2_PROXY_PUT_MAX = 4 * 1024 * 1024;

/** R2 requires ≥5 MiB for every non-final multipart part. */
export const R2_MULTIPART_PART_SIZE = 8 * 1024 * 1024;
