/** Shared R2 upload sizing (safe for client + server). */

/** Stay under Vercel hobby request body limits (~4.5 MiB). */
export const R2_PROXY_PUT_MAX = Math.floor(3.5 * 1024 * 1024);

/**
 * Multipart part size for R2. Must be ≥5 MiB for every non-final part.
 * Exactly two proxy chunks (3.5 + 3.5) so we never need browser→R2 CORS.
 */
export const R2_MULTIPART_PART_SIZE = R2_PROXY_PUT_MAX * 2;
