/** Response body of `GET /health` on both the gateway and edge. */
export interface HealthResponse {
  status: "ok";
  service: "gateway" | "edge";
  version: string;
}
