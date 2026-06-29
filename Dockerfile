# ghostdev — Claude Code in your browser.
# Single image: ttyd + tmux + nginx + the stats backend, optionally with Claude Code preinstalled.
FROM debian:bookworm-slim

ARG TARGETARCH
ARG TTYD_VERSION=1.7.7
# Set to "false" to build a vanilla web terminal without the Claude Code CLI.
ARG INSTALL_CLAUDE=true
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      nginx-light nodejs npm tmux ca-certificates curl gettext-base tini procps git less \
    && rm -rf /var/lib/apt/lists/*

# ttyd static release binary (multi-arch).
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in amd64) t=x86_64;; arm64) t=aarch64;; arm) t=arm;; *) t=x86_64;; esac; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${t}" -o /usr/local/bin/ttyd; \
    chmod +x /usr/local/bin/ttyd; \
    /usr/local/bin/ttyd --version

# Claude Code CLI (the whole point). Skip with --build-arg INSTALL_CLAUDE=false.
RUN if [ "$INSTALL_CLAUDE" = "true" ]; then \
      npm install -g @anthropic-ai/claude-code && npm cache clean --force; \
    fi

# Non-root runtime user.
RUN useradd -m -s /bin/bash -u 1000 ghost

COPY web/                       /var/www/ghostdev/
COPY stats/                     /opt/ghostdev-stats/
COPY config/tmux.conf           /home/ghost/.tmux.conf
COPY config/bashrc.snippet      /tmp/bashrc.snippet
COPY docker/nginx.conf.tmpl     /etc/nginx/templates/ghostdev.conf.tmpl
COPY docker/entrypoint.sh       /usr/local/bin/ghostdev-entrypoint

RUN cat /tmp/bashrc.snippet >> /home/ghost/.bashrc \
    && rm /tmp/bashrc.snippet \
    && chmod +x /usr/local/bin/ghostdev-entrypoint \
    && chown -R ghost:ghost /home/ghost /opt/ghostdev-stats /var/www/ghostdev

USER ghost
WORKDIR /home/ghost
EXPOSE 7680

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ghostdev-entrypoint"]
