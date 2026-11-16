/** Default listening ports. Each can be overridden by its environment variable. */
export const DEFAULT_PORTS = {
  /** edge: public API entry (`EDGE_API_PORT`). */
  edgeApi: 8080,
  /** edge: outbound HTTP/CONNECT proxy (`EDGE_PROXY_PORT`). */
  edgeProxy: 3128,
  /** gateway inside the agent container, internal network only (`GATEWAY_PORT`). */
  gateway: 8090,
} as const;
