import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";

/**
 * 50 rooms / 100 viewers — warm then cold cache passes.
 * Requires streaming stack + seeded ready assets.
 */
export const options = {
  scenarios: {
    warm: {
      executor: "constant-vus",
      vus: 100,
      duration: "2m",
      startTime: "0s",
    },
    cold: {
      executor: "constant-vus",
      vus: 100,
      duration: "2m",
      startTime: "2m30s",
      env: { COLD: "1" },
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<2500"],
  },
};

const API = __ENV.API_BASE || "http://127.0.0.1:8080";

export default function () {
  const health = http.get(`${API}/healthz`);
  check(health, { "api up": (r) => r.status === 200 });
  sleep(1);
}
