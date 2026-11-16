# syntax=docker/dockerfile:1
# Agent image: gateway + Pi + toolchains (mise). Multi-arch (amd64/arm64).
# No secrets: GITHUB_TOKEN and the API keys arrive at runtime through the environment.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# build: installs everything and compiles the workspaces
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/edge/package.json packages/edge/package.json
RUN npm ci
COPY packages/ packages/
RUN npm run build

# ---------------------------------------------------------------------------
# prod-deps: production dependencies only
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/edge/package.json packages/edge/package.json
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# System packages. The system `node` (/usr/local/bin) runs the gateway and Pi.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git ripgrep fd-find jq build-essential unzip \
 && install -dm 0755 /etc/apt/keyrings \
 && curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
      https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && curl -fsSL -o /tmp/mise-gpg-key.pub https://mise.jdx.dev/gpg-key.pub \
 && gpg --dearmor -o /etc/apt/keyrings/mise-archive-keyring.gpg /tmp/mise-gpg-key.pub \
 && rm -f /tmp/mise-gpg-key.pub \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/mise-archive-keyring.gpg] https://mise.jdx.dev/deb stable main" \
      > /etc/apt/sources.list.d/mise.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh mise \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# agent user (uid/gid 1000): renames the `node` user from the base image.
RUN groupmod -n agent node \
 && usermod -l agent -d /home/agent -m node

# Toolchains with mise. Shims go after /usr/local/bin so they do not replace the system node.
ENV MISE_DATA_DIR=/opt/mise \
    MISE_CONFIG_DIR=/etc/mise \
    MISE_TRUSTED_CONFIG_PATHS=/data/workspace \
    PATH=/usr/local/sbin:/usr/local/bin:/opt/mise/shims:/usr/sbin:/usr/bin:/sbin:/bin
COPY docker/mise/config.toml /etc/mise/config.toml
RUN mise install \
 && mise reshim \
 && chown -R agent:agent /opt/mise

# Application: dist and package.json of shared and gateway (type: module); production node_modules.
# The workspace links in node_modules (@cna/shared -> packages/shared) remain valid.
WORKDIR /app
COPY --from=build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/gateway/package.json /app/packages/gateway/package.json
COPY --from=build /app/packages/gateway/dist /app/packages/gateway/dist
COPY --from=prod-deps /app/node_modules /app/node_modules

# Pi: build-time check and global link. Config goes to a temporary directory so nothing
# is left as root in the /data volume.
RUN PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 PI_CODING_AGENT_DIR=/tmp/pi-check \
    /app/node_modules/.bin/pi --version \
 && rm -rf /tmp/pi-check \
 && ln -sf /app/node_modules/.bin/pi /usr/local/bin/pi

# /data volume (owned by agent). The entrypoint creates the subdirectories.
RUN install -d -o agent -g agent /data
VOLUME /data

# Maven and Gradle: egress through edge; cache in the volume.
RUN install -d -o agent -g agent /home/agent/.m2
COPY --chown=agent:agent docker/maven/settings.xml /home/agent/.m2/settings.xml
RUN install -dm 0755 /etc/cna
COPY docker/gradle/gradle.properties /etc/cna/gradle.properties
COPY --chmod=0755 docker/agent-entrypoint.sh /usr/local/bin/agent-entrypoint.sh

# Egress proxy (ADR-0004). Placed after the RUN steps that need direct network access.
ENV HTTPS_PROXY=http://edge:3128 \
    HTTP_PROXY=http://edge:3128 \
    https_proxy=http://edge:3128 \
    http_proxy=http://edge:3128 \
    NO_PROXY=localhost,127.0.0.1,edge \
    no_proxy=localhost,127.0.0.1,edge \
    NODE_USE_ENV_PROXY=1 \
    JAVA_TOOL_OPTIONS="-Dhttp.proxyHost=edge -Dhttp.proxyPort=3128 -Dhttps.proxyHost=edge -Dhttps.proxyPort=3128 -Dhttp.nonProxyHosts=localhost|127.0.0.1|edge" \
    GRADLE_OPTS="-Dorg.gradle.daemon=false -Xmx1g" \
    MAVEN_OPTS="-Xmx1g"

# Caches, Gradle and Pi.
ENV GRADLE_USER_HOME=/data/cache/gradle \
    npm_config_cache=/data/cache/npm \
    UV_CACHE_DIR=/data/cache/uv \
    PIP_CACHE_DIR=/data/cache/pip \
    GOPATH=/data/cache/go \
    GOMODCACHE=/data/cache/go/mod \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_CODING_AGENT_DIR=/data/config/pi \
    GATEWAY_PORT=8090

USER agent
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8090/health').then(async (r) => { const b = await r.json(); process.exit(r.ok && b.status === 'ok' ? 0 : 1); }).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/agent-entrypoint.sh"]
CMD ["node", "packages/gateway/dist/main.js"]
